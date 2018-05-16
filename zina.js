const slack = require('@slack/client');
const fs = require('fs');
const request = require('request');

const BOT_NAME = 'zina';
const BOT_CHANNEL = 'claim_channel';
const SERVERSLIST_DIR = 'servers';
const INFO_DIR = 'info';
// const CLIAM_TIME = 1000*60*2;
const CLIAM_TIME = 1000 * 60 * 60 * 48;
const DESTROY_TIME = 1000 * 60 * 60;
const CHECK_SERVERS_STATUS_INTERVAL = 1000 * 10;

const RtmClient = slack.RtmClient;
const CLIENT_EVENTS = slack.CLIENT_EVENTS;
const RTM_EVENTS = slack.RTM_EVENTS;
const MemoryDataStore = slack.MemoryDataStore;
const token = process.env.SLACK_API_TOKEN;

const rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore(), // pass a new MemoryDataStore instance to cache information
});

rtm.start();

let rtmData;
rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, (rtmStartData) => {
  console.log('RTM client authenticated!'/* , Object.keys(rtmStartData) */);
  rtmData = rtmStartData;
});

function getDirectMsgChannel(userId) {
  for (const i in rtmData.ims) {
    if (rtmData.ims[i].user === userId) {
      return rtmData.ims[i].id;
    }
  }
  return null;
}

rtm.on(RTM_EVENTS.MESSAGE, (message) => {
  let context;
  let slackuser;
  try {
    if (!message.user || !message.text) {
      return;
    }

    slackuser = getSlackUser(message.user);
    if (!slackuser) {
      return;
    }

    const data = parseMessage(message.text);
    if (!data) {
      return;
    }

    context = {
      slackuser,
      slackuserDM: getDirectMsgChannel(message.user),
      write(msg) {
        rtm.sendMessage(msg, message.channel);
      },
    };
    switch (data.cmd) {
      case 'get':
        context.server = data.params[0];
        claimServer(context); break;
      case 'free':
        context.server = data.params[0];
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
    context.write(`${slackuser} ${result}`);
  }
});

//-----------------------------------------------------------
function getSlackUser(user) {
  const userobj = rtm.dataStore.getUserById(user);
  if (!userobj) {
    return null;
  }
  return userobj.name;
}

//-----------------------------------------------------------
function claimServer(context) {
  const data = readServerData(context.server);

  if (context.server.indexOf('dev-linode') > -1) {
    context.write(`ERROR. ${context.server} outdated. Use sandbox-**`);
    return;
  }

  const currentTime = Date.now();
  if (data.valid_till_timestamp && context.slackuser !== data.owner) {
    if (currentTime < data.valid_till_timestamp) {
      context.write(`ERROR. ${context.server} is owned by ${data.owner} till ${getDateFromTimestamp(data.valid_till_timestamp)}`);
      return;
    }
  }

  const userchange = data.owner && data.owner !== context.slackuser;
  const lastOwner = data.owner;
  let claimTimeOverride;
  if (data.config.acquire_infinitely) {
    claimTimeOverride = new Date('2020-02-02').valueOf();
  }
  data.valid_till_timestamp = getClaimTimeRight(claimTimeOverride);
  data.owner = context.slackuser;
  data.ownerDM = context.slackuserDM;

  writeServerData(context.server, data);

  let result = `${context.server} is yours ${data.owner} till ${getDateFromTimestamp(data.valid_till_timestamp)}`;
  if (userchange) {
    result += `\n${lastOwner} lost ownership\n`;
  }
  context.write(result);

  if (!data.server_created_timestamp) {
    data.server_created_timestamp = Date.now();
    if (data.config.webhook_create_server) {
      webhookCreateServer(context, data.config.webhook_create_server, (err) => {
        if (!err) {
          // update server creation time
          writeServerData(context.server, data);
        }
      });
    }
  }
}

//-----------------------------------------------------------
function unClaimServer(context) {
  const data = readServerData(context.server);
  const currentTime = Date.now();
  const expired = data.valid_till_timestamp < currentTime;
  const lastOwner = data.owner;

  if (!expired && context.slackuser !== data.owner) {
    context.write(`ERROR. ${context.server} is owned by ${data.owner}`);
    return;
  }

  data.valid_till_timestamp = currentTime;
  data.owner = undefined;
  writeServerData(context.server, data);

  let result = `${context.server} is free`;
  if (lastOwner) {
    result += `\n${lastOwner} lost ownership`;
  }
  context.write(result);
}

//-----------------------------------------------------------
function compareServerName(objA, objB) {
  if (objA.server < objB.server) {
    return -1;
  } else if (objA.server > objB.server) {
    return +1;
  }
  return 0;

}

//-----------------------------------------------------------
function listServers(context) {
  const datas = readServersData();
  const result = [];
  const currentTime = Date.now();

  for (const idx in datas) {
    const data = datas[idx];
    if (!data.valid_till_timestamp || data.valid_till_timestamp <= currentTime) {
      result.push(`${data.server} is free`);
    } else {
      result.push(`${data.server} is owned by ${data.owner} till ${getDateFromTimestamp(data.valid_till_timestamp)}`);
    }
  }

  context.write(result.join('\n'));
}

//-----------------------------------------------------------
function printHelp(context) {
  context.write(`${BOT_NAME} list
${BOT_NAME} get <server>
${BOT_NAME} free <server>`);
}

//-----------------------------------------------------------
function checkServersLoop() {
  try {
    if (!rtm.connected) {
      console.log('checkServersLoop: not connected...');
      return;
    }

    const channel = rtm.dataStore.getChannelByName(BOT_CHANNEL);
    if (!channel) {
      console.log(`Cant find channel ${BOT_CHANNEL} (absent or private)`);
      return;
    }

    const result = [];
    const currentTime = Date.now();
    const datas = readServersData();

    for (const idx in datas) {
      const data = datas[idx];
      if (!data.valid_till_timestamp) {
        continue;
      }
      if (data.valid_till_timestamp < currentTime) {
        freeServerByBot(data.server, data, channel.id);
      }
      if (data.valid_till_timestamp + DESTROY_TIME < currentTime) {
        destroyServerByBot(data.server, data, channel.id);
      }
    }
  } catch (e) {
    console.error('loop', e);
  }
}
setInterval(checkServersLoop, CHECK_SERVERS_STATUS_INTERVAL);

//-----------------------------------------------------------
function freeServerByBot(server, data, channelId) {
  if (data.owner) {
    const lastowner = data.owner;
    const lastownerDM = data.ownerDM;
    data.owner = undefined;
    data.ownerDM = undefined;
    writeServerData(server, data);

    rtm.sendMessage(`${server} released by bot\n${lastowner} lost ownership`, channelId);
    if (lastownerDM) {
      rtm.sendMessage(`${server} released by bot\n${lastowner} lost ownership`, lastownerDM);
    }
  }
}

//-----------------------------------------------------------
function destroyServerByBot(server, data, channelId) {
  if (data.server_created_timestamp) {
    data.server_created_timestamp = undefined;
    writeServerData(server, data);

    if (data.config.webhook_destroy_server) {
      const context = {
        server,
        write(msg) {
          rtm.sendMessage(msg, channelId);
        },
      };
      webhookDestroyServer(context, data.config.webhook_destroy_server);
    }
  }
}

//-----------------------------------------------------------
function webhookCreateServer(context, url, callback) {
  context.write(`Jenkins: ${context.server} being created...`);
  request(url, (err, data) => {
    if (err) {
      context.write(`Jenkins: ${context.server} CREATING ERROR!`);
      console.log('webhook_create_server ERR', err);
    } else {
      context.write(`Jenkins: ${context.server} created!`);
    }
    if (callback) { callback(err); }
  });
}

function webhookDestroyServer(context, url) {
  context.write(`Jenkins: ${context.server} being destroyed...`);
  request(url, (err, data) => {
    if (err) {
      context.write(`Jenkins: ${context.server} DESTROYING ERROR!`);
      console.log('webhook_destroy_server ERR', context.server, url, err);
    } else {
      context.write(`Jenkins: ${context.server} demolished!`);
    }
  });
}

//-----------------------------------------------------------
function readServerData(server) {
  const data = {};
  try {
    const serverFileName = [SERVERSLIST_DIR, server].join('/');
    data.config = JSON.parse(fs.readFileSync(serverFileName));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Unknown server: ${server}`);
    }
    console.error(e);
    throw new Error(`Internal error while reading: ${server}`);
  }

  try {
    const infoFileName = [INFO_DIR, server].join('/');
    const info = JSON.parse(fs.readFileSync(infoFileName));
    for (const key in info) {
      data[key] = info[key];
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('error reading info:', server, e);
    }
  }
  data.server = server;
  return data;
}

//-----------------------------------------------------------
function readServersData() {
  const serversList = fs.readdirSync(SERVERSLIST_DIR);
  const result = [];

  for (const idx in serversList) {
    const server = serversList[idx];
    const data = readServerData(server);
    result.push(data);
  }

  result.sort(compareServerName);
  return result;
}

//-----------------------------------------------------------
function writeServerData(server, data) {
  const serverFileName = [INFO_DIR, server].join('/');
  const dataCopy = JSON.parse(JSON.stringify(data));
  delete dataCopy.config;
  fs.writeFileSync(serverFileName, JSON.stringify(dataCopy));
}

//-----------------------------------------------------------
function parseMessage(message) {
  if (!message) return null;

  if (message[0] === '<' && message[1] === '@') {
    const usernameEnd = message.indexOf('>');
    const user = message.slice(2, usernameEnd);
    const slackuser = getSlackUser(user);
    if (!slackuser || slackuser.indexOf(BOT_NAME) !== 0) {
      return null;
    }
  }
  else if (message.indexOf(BOT_NAME) !== 0) {
    return null;
  }

  const parts = message.split(' ');

  return {
    cmd: parts[1],
    params: parts.slice(2),
  };
}

//-----------------------------------------------------------
function getClaimTimeRight(claimTimeOverride) {
  if (Number.isFinite(claimTimeOverride)) {
    const validTillDate = new Date(claimTimeOverride);
    return validTillDate.valueOf();
  }

  const dayEnd = new Date();
  dayEnd.setHours(23);

  // чтобы обойти лимиты slack на отпавку сообщений 1 в секунду.
  const randomMin = Math.floor(Math.random()*59);
  const randomSec = Math.floor(Math.random()*59);
  dayEnd.setMinutes(randomMin);
  dayEnd.setSeconds(randomSec);

  // const claimTime = new Date(Date.now() + CLIAM_TIME);
  // weekends are not counted
  // const dayOfWeek = claimTime.getDay();
  // if (dayOfWeek === 0 || dayOfWeek === 6) {
  //   claimTime.setHours(claimTime.getHours() + 48);
  // }
  return dayEnd.valueOf();
}

//-----------------------------------------------------------
function getDateFromTimestamp(timestamp) {
  return `${new Date(timestamp).toJSON().slice(0, 19).replace('T', ' ')} (GMT)`;
}

