var slack = require('@slack/client');
var fs = require('fs');
var request = require('request');

var RtmClient = slack.RtmClient;
var CLIENT_EVENTS = slack.CLIENT_EVENTS;
var RTM_EVENTS = slack.RTM_EVENTS;
var MemoryDataStore = slack.MemoryDataStore;
var token = process.env.SLACK_API_TOKEN;
var token2 = process.env.SLACK_API_TOKEN_LEGACY;
var configName = 'guardian.conf';

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
    if (!channel) {
      if(config.admins[slackuser]){
        processAdminMessage(message.text, message.channel);
        return;
      }
      console.log("error getting channel", message);
      return;
    }
    console.log(channel, slackuser, 'thread:' + Boolean(message.thread_ts), message.text);

    if (!config.protect[channel] || config.protect[channel][slackuser] || message.thread_ts /*threads allowed*/) {
      return;
    }

    console.log('DELETE MESSAGE ^^^');
    var url =  'https://slack.com/api/chat.delete?token=' + token2;
    url += "&ts=" + message.ts;
    url += "&channel=" + message.channel;
    url += "&as_user=true&pretty=1";

    request(url, function(err, data) {
      if(err){
        console.log(err);
      }
    });
  } catch(err) {
    console.error(err, err.stack);
  }
});

function processAdminMessage(message, msgChannelId) {
  var parts = message.split(' ');
  var cmd = parts[0];
  var channel = parts[1];
  var name = parts[2];

  if (cmd == 'add'){
    var user = rtm.dataStore.getUserByName(name);
    if (!user) {
      rtm.sendMessage("failed. unknown user " + name, msgChannelId);
      return;
    }
    var channelId = rtm.dataStore.getChannelByName(channel);
    if (!channelId) {
      rtm.sendMessage("failed. unknown channel " + channel, msgChannelId);
      return;
    }

    if(!config.protect[channel]){
      config.protect[channel] = {};
    }
    config.protect[channel][name] = true;
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage("ok", msgChannelId);
  }

  else if (cmd == 'list'){
    var msg = [];
    for (var chan in config.protect) {
      for(var usr in config.protect[chan]) {
        msg.push([chan, usr].join(' '));
      }
    }
    rtm.sendMessage(msg.join('\n'), msgChannelId);
  }

  else if (cmd == 'del'){
    var user = rtm.dataStore.getUserByName(name);
    if (!user) {
      rtm.sendMessage("failed. unknown user " + name, msgChannelId);
      return;
    }
    var channelId = rtm.dataStore.getChannelByName(channel);
    if (!channelId) {
      rtm.sendMessage("failed. unknown channel " + channel, msgChannelId);
      return;
    }

    delete config.protect[channel][name];
    if (Object.keys(config.protect[channel]).length == 0){
      delete config.protect[channel];
    }
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage("ok", msgChannelId);
  }
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



