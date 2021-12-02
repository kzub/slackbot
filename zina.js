const slack = require('@slack/rtm-api');
const fs = require('fs');
const request = require('request');
const express = require('express');
const bodyParser = require('body-parser');

const BOT_NAME = process.env.BOT_NAME || 'zina';
const BOT_CHANNEL = process.env.BOT_CHANNEL || 'claim_channel';
const SERVERSLIST_DIR = 'servers';
const INFO_DIR = 'info';
const DEFAULT_CLIAM_TIME = 1000 * 60 * 60 * 24;
const CHECK_SERVERS_STATUS_INTERVAL = 1000 * 10;
let BOT_CHANNEL_ID;

const app = express();
const { host, port } = process.env;

app.use(bodyParser.json());
app.listen(port, host, () => {
  console.log(`Zina listening on port ${host}:${port}!`);
});

process.on('unhandledRejection', function(reason, p){
   console.log('unhandledRejection', reason, p);
});

process.on('uncaughtException', function(error) {
       console.log('uncaughtException', error);
});

// Webhook. Принимает результат создания новой виртуалки и отправляет владельцу в чат
// Формат: { "serverName": "beta-00", "action": "bootstrap", "result": "ok" }
app.post('/webhook', (req, res) => {
  const { serverName, action, status, text = '' } = req.body;
  console.log('/webhook', req.body);

  if (!serverName) {
    console.log('ERROR: bad webhook format, no serverName field');
    res.status(400).json({ error: 'bad webhook format'});
    return;
  }

  switch (status) {
    case 'ok':
      notifyServerOwner(serverName, `Jenkins: ${serverName} ${action} ok\n${text}`); break;
    case 'fail':
      notifyServerOwner(serverName, `Jenkins: ${serverName} ${action} error! Call for help -> #ops-duty\n${text}`); break;
    case 'inprogress':
      notifyServerOwner(serverName, `Jenkins: ${serverName} ${action}\n${text}`); break;
    default:
      console.log('ERROR: bad webhook format, undefined status');
      res.status(400).json({ error: 'bad webhook format'});
      return;
  }

  res.json({ ok: true });
});

const rtm = new slack.RTMClient(process.env.SLACK_API_TOKEN, {
  logLevel: slack.LogLevel.INFO
  clientPingTimeout: 120000,
  serverPongTimeout: 60000,
});

rtm.start();

// ---------------------------------------
function notifyServerOwner (serverName, message) {
  const state = readServerState(serverName);
  const toWhom = state.ownerDM || state.lastOwnerDM;
  if (toWhom) {
    rtm.sendMessage(message, toWhom);
  }
}

rtm.on('connected', async () => {
  BOT_CHANNEL_ID = await getSlackChannelByName(BOT_CHANNEL);
  console.log('RTM client authenticated! userId:', rtm.activeUserId, 'BOT_CHANNEL_ID', BOT_CHANNEL_ID);
});

//-----------------------------------------------------------
async function getSlackChannelByName(name) {
  let oneMoreStep = true;
  let channels = [];
  for (let res ; oneMoreStep == true;) {
    res = await rtm.webClient.conversations.list({
      exclude_archived: true,
      // limit: 500,
      cursor:  res && res.response_metadata.next_cursor
    });

    if (!res.ok) {
      return null;
    }
    channels = channels.concat(res.channels);
    // console.log(res.channels.length, res.response_metadata.next_cursor, oneMoreStep)
    oneMoreStep = res.response_metadata.next_cursor && res.response_metadata.next_cursor.length > 0;
  }

  // console.log(`TOTAL CHANNELS: ${channels.length}`);
  const channel = channels.filter(m => m.name == name).pop();
  return channel && channel.id;
}

//-----------------------------------------------------------
async function getSlackUser(userId) {
  const res = await rtm.webClient.users.info({ user: userId });
  if (!res.ok) {
    return null;
  }
  return res.user.name;
}

//-----------------------------------------------------------
async function getDirectMsgChannel(userId) {
  const res = await rtm.webClient.conversations.open({ users: userId });

  if (!res.ok) {
    return;
  }
  return res.channel.id;
}

//-----------------------------------------------------------
rtm.on('message', async (message) => {
  let context;
  let slackuser;
  try {
    if (!message.user || !message.text) {
      return;
    }

    slackuser = await getSlackUser(message.user);
    if (!slackuser) {
      return;
    }

    const data = await parseMessage(message);
    if (!data) {
      return;
    }
    console.log(data)

    context = {
      slackuser,
      slackuserDM: await getDirectMsgChannel(message.user),
      sendMessage(msg) {
        rtm.sendMessage(msg, message.channel);
      },
    };

    switch (data.cmd) {
      case 'get':
        context.serverName = data.params[0];
        claimServer(context); break;
      case 'free':
        context.serverName = data.params[0];
        unClaimServer(context); break;
      case 'list':
        context.listOption = data.params[0];
        listServers(context); break;
      case 'help':
      default:
        printHelp(context);
    }
  } catch (err) {
    console.error(err, err.stack);
    const result = err.message || 'Internal error';
    context.sendMessage(`${slackuser} ${result}`);
  }
});


//-----------------------------------------------------------
function claimServer(context) {
  const state = readServerState(context.serverName);

  const currentTime = Date.now();
  if (state.valid_till_timestamp && context.slackuser !== state.owner) {
    if (currentTime < state.valid_till_timestamp) {
      context.sendMessage(`ERROR. ${context.serverName} is owned by ${state.owner} till ${getDateFromTimestamp(state.valid_till_timestamp)}`);
      return;
    }
  }

  const userchange = state.owner && state.owner !== context.slackuser;
  const lastOwner = state.owner;

  state.valid_till_timestamp = getClaimTimeRight(state._config);
  state.owner = context.slackuser;
  state.ownerDM = context.slackuserDM;

  writeServerState(state);

  let result = `${context.serverName} is yours ${state.owner} till ${getDateFromTimestamp(state.valid_till_timestamp)}`;
  if (userchange) {
    result += `\n${lastOwner} lost ownership\n`;
  }
  context.sendMessage(result);

  if (state._config.dynamic_bootstrap) {
    jenkinsCreateServer(context, state._config);
  }
}

//-----------------------------------------------------------
function unClaimServer(context) {
  const state = readServerState(context.serverName);
  const currentTime = Date.now();
  const expired = state.valid_till_timestamp < currentTime;
  const lastOwner = state.owner;

  if (!expired && state.owner && context.slackuser !== state.owner) {
    context.sendMessage(`ERROR. ${context.serverName} is owned by ${state.owner}`);
    return;
  }

  state.valid_till_timestamp = currentTime;
  state.owner = undefined;
  state.lastOwner = lastOwner;
  writeServerState(state);

  let result = `${context.serverName} is free`;
  if (lastOwner) {
    result += `\n${lastOwner} lost ownership`;
  }
  if (state._config.dynamic_bootstrap) {
    const destroyTime = Math.round(state._config.unclaim_to_destroy_time/1000/60);
    result = `\nwill be destroyed after ${destroyTime} minutes of idle`;
  }
  context.sendMessage(result);
}

//-----------------------------------------------------------
function compareServerName(objA, objB) {
  if (objA._serverName < objB._serverName) {
    return -1;
  } else if (objA._serverName > objB._serverName) {
    return +1;
  }
  return 0;

}

//-----------------------------------------------------------
function listServers(context) {
  const states = readAllServersState();
  const result = [];
  const currentTime = Date.now();

  for (const state of states) {
    let dynamic = '';
    if (state._config.dynamic_bootstrap) {
      dynamic = ' (dynamic)';
    }
    if (state._config.team) {
      dynamic = `-${state._config.team}` + dynamic;
    }
    if (!state.valid_till_timestamp || state.valid_till_timestamp <= currentTime) {
      result.push(`${state._serverName}${dynamic} is free`);
    } else {
      if (context.listOption == 'free') { continue; }
      result.push(`${state._serverName}${dynamic} is owned by ${state.owner} till ${getDateFromTimestamp(state.valid_till_timestamp)}`);
    }
  }

  context.sendMessage(result.join('\n'));
}

//-----------------------------------------------------------
function printHelp(context) {
  context.sendMessage(`list
get <server>
free <server>`);
}

//-----------------------------------------------------------
function checkServersLoop() {
  try {
    if (!rtm.connected) {
      console.log('checkServersLoop: not connected...');
      return;
    }
    if (!BOT_CHANNEL_ID) {
      console.log('checkServersLoop: channel id not set');
      return;
    }

    const currentTime = Date.now();
    const states = readAllServersState();

    for (const state of states) {
      if (!state.valid_till_timestamp) {
        continue;
      }
      if (state.valid_till_timestamp < currentTime) {
        freeServerByBot(state, BOT_CHANNEL_ID);
      }
      if (state.valid_till_timestamp + state._config.unclaim_to_destroy_time < currentTime) {
        destroyServerByBot(state, BOT_CHANNEL_ID);
      }
    }
  } catch (err) {
    console.log('ERROR checkServersLoop()', err);
  }
}
setInterval(checkServersLoop, CHECK_SERVERS_STATUS_INTERVAL);

//-----------------------------------------------------------
function freeServerByBot(state, channelId) {
  if (state.owner) {
    const lastOwner = state.owner;
    const lastOwnerDM = state.ownerDM;
    state.lastOwner = state.owner;
    state.lastOwnerDM = state.ownerDM;
    state.owner = undefined;
    state.ownerDM = undefined;
    writeServerState(state);

    let destroyMsg = '';
    if (state._config.dynamic_bootstrap) {
      const destroyTime = Math.round(state._config.unclaim_to_destroy_time/1000/60);
      destroyMsg = `\nwill be destroyed after ${destroyTime} minutes of idle`;
    }
    rtm.sendMessage(`${state._serverName} released by bot\n${lastOwner} lost ownership${destroyMsg}`, channelId);
    if (lastOwnerDM) {
      rtm.sendMessage(`${state._serverName} released by bot${destroyMsg}`, lastOwnerDM);
    }
  }
}

//-----------------------------------------------------------
function destroyServerByBot(state, channelId) {
  const context = {
    slackuser: state.lastOwner,
    serverName: state._serverName,
    sendMessage(msg) {
      rtm.sendMessage(msg, channelId);
      if (state.lastOwnerDM) {
        rtm.sendMessage(msg, state.lastOwnerDM);
      }
    },
  };
  state.valid_till_timestamp = undefined;
  writeServerState(state);
  jenkinsDestroyServer(context, state._config);
}

//-----------------------------------------------------------
function jenkinsCreateServer(context, config) {
  const payload = {
    ...config.bootstrap_payload,
    SLACK_USER: context.slackuser,
  };

  request.post({
    url: config.bootstap_url,
    headers: config.jenkins_headers,
    timeout: 10000,
    form: payload,
  }, (err, httpResponse) => {
    // console.log(err, httpResponse, body)
    if (err) {
      context.sendMessage(`Jenkins: ${context.serverName} bootstap error!`);
      console.log('ERROR jenkinsCreateServer(1)', context.serverName, err);
      return;
    }
    if (httpResponse && httpResponse.statusCode !== 201) {
      context.sendMessage(`Jenkins: ${context.serverName} bootstap error!
${httpResponse.statusCode} ${httpResponse.statusMessage}
Call for help -> #ops_duty`);
      console.log('ERROR jenkinsCreateServer(2)', context.serverName, httpResponse && httpResponse.statusCode, httpResponse && httpResponse.statusMessage, err);
      return;
    }

    context.sendMessage(`Jenkins: ${context.serverName} bootstrap triggered ...`);
  });
}

function jenkinsDestroyServer(context, config) {
  const payload = {
    ...config.destroy_payload,
    SLACK_USER: context.slackuser,
  };

  request.post({
    url: config.destroy_url,
    headers: config.jenkins_headers,
    timeout: 10000,
    form: payload,
  }, (err, httpResponse) => {
        if (err) {
      context.sendMessage(`Jenkins: ${context.serverName} bootstap error!`);
      console.log('ERROR jenkinsDestroyServer(1)', context.serverName, err);
      return;
    }
    if (httpResponse && httpResponse.statusCode !== 201) {
      context.sendMessage(`Jenkins: ${context.serverName} bootstap error!
${httpResponse.statusCode} ${httpResponse.statusMessage}
Call for help -> #ops_duty`);
      console.log('ERROR jenkinsDestroyServer(2)', context.serverName, httpResponse && httpResponse.statusCode, httpResponse && httpResponse.statusMessage, err);
      return;
    }
    context.sendMessage(`Jenkins: ${context.serverName} destroy triggered ...`);
  });
}

//-----------------------------------------------------------
function readServerState(serverName) {
  const state = {};

  // config
  const serverFileName = [SERVERSLIST_DIR, serverName].join('/');
  try {
    state._config = JSON.parse(fs.readFileSync(serverFileName));
    state._serverName = serverName;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Unknown server: ${serverName}`);
    }
    console.log('ERROR readServerState() config', serverFileName, err);
    throw new Error(`Internal error while reading: ${serverName}`);
  }

  // state
  const stateFileName = [INFO_DIR, serverName].join('/');
  try {
    const info = JSON.parse(fs.readFileSync(stateFileName));
    for (const key in info) {
      state[key] = info[key];
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.log('ERROR readServerState() state', stateFileName, err);
    }
  }

  return state;
}

//-----------------------------------------------------------
function readAllServersState() {
  const serversList = fs.readdirSync(SERVERSLIST_DIR);
  const result = [];

  for (const idx in serversList) {
    const serverName = serversList[idx];
    const state = readServerState(serverName);
    result.push(state);
  }

  result.sort(compareServerName);
  return result;
}

//-----------------------------------------------------------
function writeServerState(state) {
  const serverFileName = [INFO_DIR, state._serverName].join('/');
  const stateCopy = JSON.parse(JSON.stringify(state));
  delete stateCopy._config;
  delete stateCopy._serverName;
  fs.writeFileSync(serverFileName, JSON.stringify(stateCopy));
}

//-----------------------------------------------------------
async function parseMessage(message) {
  let text = message.text;
  let user = message.user;

  if (!text) {
    return null;
  }

  if (user) {
    user = await getSlackUser(message.user);
  }

  if (message.channel.startsWith('D')) { // direct message
    if (text.startsWith(BOT_NAME)) {
      text = text.slice(BOT_NAME.length + 1);
    }
    const parts = text.split(' ');
    return {
      cmd: parts[0],
      params: parts.slice(1),
      user,
    };
  }

  if (text[0] === '<' && text[1] === '@') {
    const usernameEnd = text.indexOf('>');
    const user = text.slice(2, usernameEnd);
    const slackuser = await getSlackUser(user);
    if (!slackuser || slackuser.indexOf(BOT_NAME) !== 0) {
      return null;
    }
  }
  else if (text.indexOf(BOT_NAME) !== 0) {
    return null;
  }

  const parts = text.split(' ');

  return {
    cmd: parts[1].toLowerCase(),
    params: parts.slice(2),
    user,
  };
}

//-----------------------------------------------------------
function getClaimTimeRight(config) {
  // до конца дня
  if (config.claim_till_day_end) {
    const dayEnd = new Date();
    dayEnd.setHours(23);

    // чтобы обойти лимиты slack на отпавку сообщений 1 в секунду.
    const randomMin = Math.floor(Math.random()*59);
    const randomSec = Math.floor(Math.random()*59);
    dayEnd.setMinutes(randomMin);
    dayEnd.setSeconds(randomSec);

    return dayEnd.valueOf();
  }

  // в конфиге задано количество времени (милисекунд) отведенных на владение
  if (isFinite(config.claim_time)) {
    return Date.now() + config.claim_time;
  }

  // режим по умолчанию
  const claimTime = new Date(Date.now() + DEFAULT_CLIAM_TIME);
  const dayOfWeek = claimTime.getDay();
  // weekends are not counted
  if (dayOfWeek === 0) { // воскресенье
    claimTime.setHours(claimTime.getHours() + 24);
  }
  else if (dayOfWeek === 6) { // суббота
    claimTime.setHours(claimTime.getHours() + 48);
  }
  return claimTime.valueOf();
}

//-----------------------------------------------------------
function getDateFromTimestamp(timestamp) {
  return `${new Date(timestamp).toJSON().slice(0, 19).replace('T', ' ')} (GMT)`;
}

