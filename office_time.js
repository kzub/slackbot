/* jshint esnext: true */

const slack = require('@slack/client');
const fs = require('fs');
const request = require('request');
const { spawn } = require('child_process');
const async = require('async');

const RtmClient = slack.RtmClient;
const CLIENT_EVENTS = slack.CLIENT_EVENTS;
const RTM_EVENTS = slack.RTM_EVENTS;
const MemoryDataStore = slack.MemoryDataStore;
const token = process.env.SLACK_API_TOKEN;
const token2 = process.env.SLACK_API_TOKEN_LEGACY;
const configName = 'office_time.conf';
const KT_HOST = process.env.KT_HOST;

//---------------------------------- SLACK BOT -----------------------------
var rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore() // pass a new MemoryDataStore instance to cache information
});

rtm.start();
rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function handleRTMAuthenticated() {
  console.log('RTM client authenticated!', new Date());
});

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
  async.parallel([
    (cb) => {
      checkUserAtSkud(message, cb);
    },
    (cb) => {
      checkUserAtKeepteam(message, (err, res) => {
        cb(undefined, res || {});
      });
    }
  ], (err, result) =>{
    if(err){
      console.log('processUserMessage::error', err);
      return;
    }
    let response = [];
    let skud = result[0];
    let kt = result[1];

    for(let date in kt){
      response.push(`${date}  ${kt[date]}`);
    }
    response.reverse();

    let lines = skud.split('\r\n');
    for(let idx in lines){
      let line = lines[idx];
      let date = line.slice(0, 10);
      if(kt[date]){
        line += kt[date];
      }
      response.push(line);
    }
    // console.log('```' + response.join('\r\n') + '```');
    rtm.sendMessage('```' + response.join('\r\n') + '```', msgChannelId);
  });
}

function processAdminMessage(message, msgChannelId) {
  const parts = message.split(' ');
  const cmd = parts[0];
  const name = parts[1];

  if (cmd == 'add'){
    let user = rtm.dataStore.getUserByName(name);
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
    let msg = [];
    for (let user in config.users) {
      msg.push(user);
    }
    rtm.sendMessage(msg.join('\n'), msgChannelId);
    return true;
  }

  if (cmd == 'del'){
    let user = rtm.dataStore.getUserByName(name);
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

function getSlackUser(user) {
  var userobj = rtm.dataStore.getUserById(user);
  if (!userobj) {
    return;
  }
  return userobj.name;
}

function getSlackChannel(channelId) {
  var chanobj = rtm.dataStore.getChannelById(channelId);
  if (!chanobj) {
    return;
  }
  return chanobj.name;
}


//---------------------------------- SKUD PART -------------------------
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
    callback(undefined, output === '' ? 'Не найдено. Имена и фамилии, пишутся с большой буквы.' : output);
  });
}

//---------------------------------- KEEPTEAM PART -----------------------------
var keepteamHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Accept': 'application/json, text/plain, */*',
  'Referer': `https://${KT_HOST}/`,
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36',
};

function keepteamAuth (callback) {
  delete keepteamHeaders.Cookie;
  var options = {
    url: `https://${KT_HOST}/api/authentication/logon`,
    method: 'POST',
    body: process.env.KT_TOKEN,
    headers: keepteamHeaders
  };

  // console.log(options);
  request(options, function (error, response, body) {
    if (response.statusCode == 204) {
      keepteamHeaders.Cookie = response.headers['set-cookie'][0];
      console.log('Session - OK');
      callback();
    } else {
      console.log('keepteamAuth::error', error, response.statusCode);
      callback(error);
    }
  });
}

function keepteamSearchName(name, callback) {
  var options = {
    url: `https://${KT_HOST}/api/employees/suggest`,
    method: 'POST',
    headers: keepteamHeaders,
    body: `{"Filter":{"Name":"${name}"},"Page":{"Size":30,"Number":1},"IsActive":true}`
  };

  request(options, function (error, response, body) {
    if (response.statusCode != 200) {
      console.log('keepteamSearchName::bad_status', error, response.statusCode);
      callback('wrong_status_code', response && response.statusCode);
      return;
    }

    try {
      let data = JSON.parse(body);
      let users = data.Result.filter(u => u.IsActive);
      if(users.length == 1) {
        callback(undefined, users[0]);
        return;
      }
      console.log('keepteamSearchName::info bad result length:', body);
      callback('empty request');
    } catch (e) {
      console.log('keepteamSearchName::error 2', body);
      callback(e);
    }
  });
}

function checkUserAtKeepteam(name, callback, retry){
  keepteamSearchName(name, (err, user) => {
    if(err == 'wrong_status_code' && user == 401 && !retry){
      keepteamAuth(() => {
        checkUserAtKeepteam(name, callback, true);
      });
      return;
    }

    if(err){
      callback(err);
      return;
    }
    // console.log(user);
    keepteamTimeOffs(user, (err, data) => {
      if(err){
        callback(err);
        return;
      }
      // console.log(data);
      callback(undefined, formatTimeOffs(data));
    });
  });
}

function keepteamTimeOffs(user, callback){
  var options = {
    url: `https://${KT_HOST}/api/TimeOffs/List`,
    method: 'POST',
    headers: keepteamHeaders,
    body: `{"Filter":{"Employees":["${user.Id}"],"IsApproved":[],"Date":{},"Types":[],"Departments":[]},"OrderBy":{"ColumnName":"Date","Descending":true},"Page":{"Number":1,"Size":50}}`
  };

  request(options, (error, response, body) => {
    if (response.statusCode != 200) {
      console.log('keepteamTimeOffs::error', error, response.statusCode);
      callback(error);
      return;
    }

    var data;
    try {
      data = JSON.parse(body).Result;
    } catch (e) {
      console.log('keepteamTimeOffs::error 2', e);
      callback(e);
      return;
    }
    callback(undefined, data);
  });
}

function formatDate(date){
  return date.toJSON().slice(0,10);
}

function formatTimeOffs(data){
  var detailed = {};
  for (let idx in data) {
    extendTimeOffs(data[idx], detailed);
  }
  return detailed;
}

function extendTimeOffs(elm, target) {
  date1 = new Date(elm.StartDate);
  date2 = new Date(elm.EndDate);

  for (; date1 <= date2; date1 = new Date(date1.valueOf() + 86400000)){
    target[formatDate(date1)] = elm.Type.Name;
  }
  return target;
}


