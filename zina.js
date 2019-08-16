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


// Webhook. Принимает результат создания новой виртуалки и отправляет владельцу в чат
// Формат: { "serverName": "beta-00", "action": "bootstrap", "result": "ok" }
app.post('/webhook', (req, res) => {
  const { serverName, action, result } = req.body;
  console.log('/webhook', req.body);

  if (!serverName) {
    console.log('ERROR: bad webhook format');
    res.status(400).end('bad webhook format');
    return;
  }

  if (result == 'ok') {
    notifyServerOwner(serverName, `Jenkins: ${serverName} ${action} ok`);
  } else {
    notifyServerOwner(serverName, `Jenkins: ${serverName} ${action} error!\nCall for help -> #ops-duty`);
  }
  res.json({ ok: true });
});

// ---------------------------------------
function notifyServerOwner (serverName, message) {
  const state = readServerState(serverName);
  const toWhom = state.ownerDM || state.lastOwnerDM;
  if (toWhom) {
    rtm.sendMessage(message, toWhom);
  }
}

const rtm = new slack.RTMClient(process.env.SLACK_API_TOKEN, {
  logLevel: slack.LogLevel.INFO
});

rtm.start();

rtm.on('connected', () => {
  console.log('RTM client authenticated! userId:', rtm.activeUserId);

  rtm.webClient.channels.list().then(res => {
    if (!res.ok) {
      console.log('ERROR channels.list() not ok');
      return;
    }
    BOT_CHANNEL_ID = res.channels.filter(chan => chan.name === BOT_CHANNEL).pop();
  });
});

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
  const res = await rtm.webClient.im.open({ user: userId });
  
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
        listServers(context); break;
      case 'help':
        printHelp(context); break;
      default: throw new Error('unknown command');
    }
  } catch (err) {
    console.error(err, err.stack);
    const result = typeof (err) === 'string' ? err : 'Internal error';
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

  if (!expired && context.slackuser !== state.owner) {
    context.sendMessage(`ERROR. ${context.serverName} is owned by ${state.owner}`);
    return;
  }

  state.valid_till_timestamp = currentTime;
  state.owner = undefined;
  writeServerState(state);

  let result = `${context.serverName} is free`;
  if (lastOwner) {
    result += `\n${lastOwner} lost ownership`;
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
    if (!state.valid_till_timestamp || state.valid_till_timestamp <= currentTime) {
      result.push(`${state._serverName} is free`);
    } else {
      result.push(`${state._serverName} is owned by ${state.owner} till ${getDateFromTimestamp(state.valid_till_timestamp)}`);
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
    state.lastOwnerDM = state.ownerDM;
    state.owner = undefined;
    state.ownerDM = undefined;
    writeServerState(state);

    rtm.sendMessage(`${state._serverName} released by bot\n${lastOwner} lost ownership`, channelId);
    if (lastOwnerDM) {
      rtm.sendMessage(`${state._serverName} released by bot`, lastOwnerDM);
    }
  }
}

//-----------------------------------------------------------
function destroyServerByBot(state, channelId) {
  const context = {
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
  request.post({
    url: config.bootstap_url,
    headers: config.jenkins_headers,
    timeout: 10000,
    form: config.bootstrap_payload,
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

    context.sendMessage(`Jenkins: ${context.serverName} bootstrap in progress ...`);
  });
}

function jenkinsDestroyServer(context, config) {
  request.post({
    url: config.destroy_url,
    headers: config.jenkins_headers,
    timeout: 10000,
    form: config.destroy_payload,
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
    context.sendMessage(`Jenkins: ${context.serverName} destroy in progress ...`);
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

  if (!text) {
    return null;
  }

  if (message.channel.startsWith('D')) { // direct message
    if (text.startsWith(BOT_NAME)) {
      text = text.slice(BOT_NAME.length + 1);
    }
    const parts = text.split(' ');
    return {
      cmd: parts[0],
      params: parts.slice(1),
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
    cmd: parts[1],
    params: parts.slice(2),
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

