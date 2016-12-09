var slack = require('@slack/client');
var fs = require('fs');
var request = require('request');

const BOT_NAME = "zina";
const BOT_CHANNEL = "zinatest";
const SERVERSLIST_DIR = "servers";
const INFO_DIR = "info";
// const CLIAM_TIME = 1000*60*2;
const CLIAM_TIME = 1000*60*60*48;
const DESTROY_TIME = 1000*60*60;
const CHECK_SERVERS_STATUS_INTERVAL = 1000*10;

var RtmClient = slack.RtmClient;
var CLIENT_EVENTS = slack.CLIENT_EVENTS;
var RTM_EVENTS = slack.RTM_EVENTS;
var MemoryDataStore = slack.MemoryDataStore;
var token = process.env.SLACK_API_TOKEN;

var rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore() // pass a new MemoryDataStore instance to cache information
});

rtm.start();

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function handleRTMAuthenticated() {
  console.log('RTM client authenticated!');
});

rtm.on(RTM_EVENTS.MESSAGE, function handleRtmMessage(message) {
  try {
    if (!message.user || !message.text) {
      return;
    }

    var slackuser = getSlackUser(message.user);
    if (!slackuser) {
      return;
    }

    var data = parseMessage(message.text);
    if (!data) {
      return;
    }

    var context = {
      slackuser: slackuser,
      write: function(msg){
        rtm.sendMessage(msg, message.channel);
      }
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
      default: throw 'unknown command';
    }
  } catch(err) {
    console.error(err, err.stack);
    var result = typeof(err) === "string" ? err : "Internal error";
    context.write("<@" + slackuser + '> ' + result);
  }
});

//-----------------------------------------------------------
function getSlackUser(user) {
  var userobj = rtm.dataStore.getUserById(user);
  if (!userobj) {
    return;
  }
  return userobj.name;
}

//-----------------------------------------------------------
function claimServer(context) {
  var data = readServerData(context.server);

  var current_time = Date.now();
  if (data.valid_till_timestamp && context.slackuser !== data.owner) {
    if(current_time < data.valid_till_timestamp) {
      context.write('ERROR. ' + context.server + ' is owned by <@' + data.owner + '> till ' +
             getDateFromTimestamp(data.valid_till_timestamp));
      return;
    }
  }

  var userchange = data.owner && data.owner != context.slackuser;
  var last_owner = data.owner;
  data.valid_till_timestamp = getClaimTimeRight(data.claim_time_override);
  data.owner = context.slackuser;
  writeServerData(context.server, data);

  var result = context.server + ' is yours <@' + data.owner + '> till ' +
               getDateFromTimestamp(data.valid_till_timestamp);
  if (userchange) {
    result += "\n<@" + last_owner + "> lost ownership\n";
  }
  context.write(result);

  if (!data.server_created_timestamp) {
    data.server_created_timestamp = Date.now();
    if (data.config.webhook_create_server) {
      webhook_create_server(context, data.config.webhook_create_server, function(err) {
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
  var data = readServerData(context.server);
  var current_time = Date.now();
  var expired = data.valid_till_timestamp < current_time;
  var last_owner = data.owner;

  if (!expired && context.slackuser !== data.owner) {
    context.write('ERROR. ' + context.server + ' is owned by <@' + data.owner + '>');
    return;
  }

  data.valid_till_timestamp = current_time;
  data.owner = undefined;
  writeServerData(context.server, data);

  var result = context.server + ' is free';
  if (last_owner) {
    result += '\n<@' + last_owner + '> lost ownership';
  }
  context.write(result);
}

//-----------------------------------------------------------
function compareServerName(objA, objB) {
  if (objA.server < objB.server) {
    return -1;
  } else if (objA.server > objB.server) {
    return +1;
  } else {
    return 0;
  }
}

//-----------------------------------------------------------
function listServers(context) {
  var datas = readServersData();
  var result = [];
  var current_time = Date.now();

  for (var idx in datas) {
    var data = datas[idx];
    if (!data.valid_till_timestamp || data.valid_till_timestamp <= current_time) {
      result.push(data.server + ' is free');
    } else {
      result.push(data.server + ' is owned by ' + data.owner + ' till ' +
                  getDateFromTimestamp(data.valid_till_timestamp));
    }
  }

  context.write(result.join('\n'));
}

//-----------------------------------------------------------
function printHelp(context) {
  context.write(
         BOT_NAME + " list\n" +
         BOT_NAME + " get <server>\n" +
         BOT_NAME + " free <server>\n"
  );
}

//-----------------------------------------------------------
function checkServersLoop() {
  try {
    if (!rtm.connected) {
      console.log('checkServersLoop: not connected...');
      return;
    }

    var channel = rtm.dataStore.getChannelByName(BOT_CHANNEL);
    if (!channel) {
      console.log('Cant find channel', BOT_CHANNEL, '(absent or private)');
      return;
    }

    var result = [];
    var current_time = Date.now();
    var datas = readServersData();

    for (var idx in datas) {
      var data = datas[idx];
      if (!data.valid_till_timestamp) {
        continue;
      }
      if (data.valid_till_timestamp < current_time) {
        freeServerByBot(data.server, data, channel.id);
      }
      if (data.valid_till_timestamp + DESTROY_TIME < current_time) {
        destroyServerByBot(data.server, data, channel.id);
      }
    }
  } catch(e) {
    console.error('loop', e);
  }
}
setInterval(checkServersLoop, CHECK_SERVERS_STATUS_INTERVAL);

//-----------------------------------------------------------
function freeServerByBot(server, data, channelId) {
  if (data.owner) {
    var lastowner = data.owner;
    data.owner = undefined;
    writeServerData(server, data);
    rtm.sendMessage(server + " released by bot\n<@" + lastowner + "> lost ownership", channelId);
  }
}

//-----------------------------------------------------------
function destroyServerByBot(server, data, channelId) {
  if (data.server_created_timestamp) {
    data.server_created_timestamp = undefined;
    writeServerData(server, data);

    if (data.config.webhook_destroy_server) {
      var context = {
        server: server,
        write: function (msg) {
          rtm.sendMessage(msg, channelId);
        }
      };
      webhook_destroy_server(context, data.config.webhook_destroy_server);
    }
  }
}

//-----------------------------------------------------------
function webhook_create_server(context, url, callback) {
  context.write('Jenkins: ' + context.server + ' being created...');
  request(url, function(err, data) {
    if (err) {
      context.write('Jenkins: ' + context.server + ' CREATING ERROR!');
      console.log('webhook_create_server ERR', err);
    } else {
      context.write('Jenkins: ' + context.server + ' created!');
    }
    if (callback) { callback(err); }
  });
}

function webhook_destroy_server(context, url) {
  context.write('Jenkins: ' + context.server + ' being destroyed...');
  request(url, function(err, data) {
    if (err) {
      context.write('Jenkins: ' + context.server + ' DESTROYING ERROR!');
      console.log('webhook_destroy_server ERR', context.server, url, err);
    } else {
      context.write('Jenkins: ' + context.server + ' demolished!');
    }
  });
}

//-----------------------------------------------------------
function readServerData(server) {
  var data = {};
  try {
    var serverFileName = [SERVERSLIST_DIR, server].join('/');
    data.config = JSON.parse(fs.readFileSync(serverFileName));
  } catch(e) {
    if (e.code === 'ENOENT') {
      throw 'Unknown server: ' + server;
    }
    console.error(e);
    throw 'Internal error while reading: ' + server;
  }

  try {
    var infoFileName = [INFO_DIR, server].join('/');
    var info = JSON.parse(fs.readFileSync(infoFileName));
    for (var key in info){
      data[key] = info[key];
    }
  } catch(e) {
    if (e.code !== 'ENOENT') {
      console.error('error reading info:', server, e);
    }
  }
  data.server = server;
  return data;
}

//-----------------------------------------------------------
function readServersData() {
  var serversList = fs.readdirSync(SERVERSLIST_DIR);
  var result = [];

  for (var idx in serversList) {
    var server = serversList[idx];
    var data = readServerData(server);
    result.push(data);
  }

  result.sort(compareServerName);
  return result;
}

//-----------------------------------------------------------
function writeServerData(server, data) {
  var serverFileName = [INFO_DIR, server].join('/');
  var dataCopy = JSON.parse(JSON.stringify(data));
  delete dataCopy.config;
  fs.writeFileSync(serverFileName, JSON.stringify(dataCopy));
}

//-----------------------------------------------------------
function parseMessage(message) {
  if (!message) return;

  if (message[0] === '<' && message[1] === '@') {
    var username_end = message.indexOf('>');
    var user = message.slice(2, username_end);
    var slackuser = getSlackUser(user);
    if (!slackuser || slackuser.indexOf(BOT_NAME) !== 0) {
      return;
    }
  }
  else if (message.indexOf(BOT_NAME) !== 0) {
    return;
  }

  var parts = message.split(' ');

  return {
    cmd: parts[1],
    params: parts.slice(2)
  };
}

//-----------------------------------------------------------
function getClaimTimeRight(claimTimeOverride) {
  if (!isFinite(claimTimeOverride)){
    claimTimeOverride = undefined;
  }
  var claimTime = new Date(Date.now() + (claimTimeOverride || CLIAM_TIME));
  var day_of_week = claimTime.getDay();
  // weekends are not counted
  if (day_of_week === 0 || day_of_week === 6) {
    claimTime.setHours(claimTime.getHours() + 48);
  }
  return claimTime.valueOf();
}

//-----------------------------------------------------------
function getDateFromTimestamp(timestamp) {
  return new Date(timestamp).toJSON().slice(0,19).replace('T',' ') + ' (GMT)';
}




