var slack = require('@slack/client');
var fs = require('fs');
var request = require('request');
const { spawn } = require('child_process');

var RtmClient = slack.RtmClient;
var CLIENT_EVENTS = slack.CLIENT_EVENTS;
var RTM_EVENTS = slack.RTM_EVENTS;
var MemoryDataStore = slack.MemoryDataStore;
var token = process.env.SLACK_API_TOKEN;
var token2 = process.env.SLACK_API_TOKEN_LEGACY;
var configName = 'office_time.conf';

var rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore() // pass a new MemoryDataStore instance to cache information
});

rtm.start();

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function handleRTMAuthenticated() {
  console.log('RTM client authenticated!', new Date());
});

var channelsMap = {};
var config = JSON.parse(fs.readFileSync(configName));

rtm.on(RTM_EVENTS.MESSAGE, function handleRtmMessage(message) {
  try {
    if (!message.user || !message.text) {
      return;
    }

    var slackuser = getSlackUser(message.user);
    if (!slackuser) {
      console.log("error getting slackuser", message);
      return;
    }
    var channel = getSlackChannel(message.channel);
    if (channel) {
      // not direct message
      return;
    }

    if(config.admins[slackuser] && processAdminMessage(message.text, message.channel)){
      return;
    }
    if(config.users[slackuser]){
      console.log(new Date().toJSON() + ' ' + slackuser + ' check user:' + message.text);
      processUserMessage(message.text, message.channel);
      return;      
    }

    rtm.sendMessage('¯\\_(ツ)_/¯', message.channel);

  } catch(err) {
    console.error(err, err.stack);
  }
});


function processUserMessage(message, msgChannelId) {
  checkUserAtSkud(message, function(result){
    rtm.sendMessage(result, msgChannelId);    
  });
}

function processAdminMessage(message, msgChannelId) {
  var parts = message.split(' ');
  var cmd = parts[0];
  var name = parts[1];

  if (cmd == 'add'){
    var user = rtm.dataStore.getUserByName(name);
    if (!user) {
      rtm.sendMessage("failed. unknown user " + name, msgChannelId);
      return true;
    }

    config.users[name] = true;
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage("ok", msgChannelId);
    return true;
  }

  if (cmd == 'list'){
    var msg = [];
    for (var user in config.users) {
      msg.push(user);
    }
    rtm.sendMessage(msg.join('\n'), msgChannelId);
    return true;
  }

  if (cmd == 'del'){
    var user = rtm.dataStore.getUserByName(name);
    if (!user) {
      rtm.sendMessage("failed. unknown user " + name, msgChannelId);
      return true;
    }
    
    delete config.users[name];
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage("ok", msgChannelId);
    return true;
  }
}

//-----------------------------------------------------------
function checkUserAtSkud(username, callback){
  const check = spawn('skud', [username]);
  var output = '';

  check.stdout.on('data', (data) => {
    output += data;
  });

  check.stderr.on('data', (data) => {
    output += data;
  });

  check.on('close', (code) => {
    callback(output === '' ? 'Не найдено. Имена и фамилии, пишутся с большой буквы.' : '```' + output + '```');
  });  
}

//-----------------------------------------------------------
function getSlackUser(user) {
  var userobj = rtm.dataStore.getUserById(user);
  if (!userobj) {
    return;
  }
  return userobj.name;
}
//-----------------------------------------------------------
function getSlackChannel(channelId) {
  var chanobj = rtm.dataStore.getChannelById(channelId);
  if (!chanobj) {
    return;
  }
  return chanobj.name;
}



