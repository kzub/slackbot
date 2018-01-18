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
const configName = process.env.OFFICEBOT_CONFIG;
const KT_HOST = process.env.KT_HOST;

if (!KT_HOST) {
  console.log('No KT_HOST');
  return;
}

const keepteamHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Accept': 'application/json, text/plain, */*',
  'Referer': `https://${KT_HOST}/`,
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36',
};

//---------------------------------- SLACK BOT -----------------------------
const rtm = new RtmClient(token, {
  logLevel: 'error', // check this out for more on logger: https://github.com/winstonjs/winston
  dataStore: new MemoryDataStore(), // pass a new MemoryDataStore instance to cache information
});

rtm.start();
rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, () => {
  console.log('RTM client authenticated!', new Date());
});

const channelsMap = {};
let config = JSON.parse(fs.readFileSync(configName));

rtm.on(RTM_EVENTS.MESSAGE, (message) => {
  try {
    if (!message.user || !message.text) {
      return;
    }
    const slackuser = getSlackUser(message.user);
    if (!slackuser) {
      console.log('error getting slackuser', message);
      return;
    }
    const direct = isSlackDirectChannel(message.channel);
    if (!direct) {
      // not direct message
      return;
    }

    if (config.admins[slackuser] && processAdminMessage(message.text, message.channel)) {
      return;
    }

    if (config.users[slackuser]) {
      console.log(`${new Date().toJSON()} ${slackuser} check user: ${message.text}`);
      processUserMessage(message.text, message.channel);
      return;
    }

    rtm.sendMessage('Нет доступа ¯\\_(ツ)_/¯', message.channel);
  } catch (err) {
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

    if(!skud.length){
      rtm.sendMessage('Не найдено. Имена и фамилии, пишутся с большой буквы.', msgChannelId);
      return;
    }

    let lines = skud.split('\r\n');
    let lastDate;
    for (const idx in lines) {
      let line = lines[idx];
      let date = line.slice(0, 10);
      if(line.indexOf('----------') === 0){
        let was = response.push(line);
        insertKTFutureDates(kt, lastDate, response);
        if(was !== response.length){
          response.push(line);
        }
        continue;
      }
      lastDate = date;
      if(kt[date]){
        line += kt[date];
      }
      response.push(line);
    }
    // console.log('```' + response.join('\r\n') + '```');
    rtm.sendMessage('```' + response.join('\r\n') + '```', msgChannelId);
  });
}

function insertKTFutureDates(kt, lastDate, response){
  let last = new Date(lastDate + 'T00:00:00Z');
  let dates = Object.keys(kt).filter(d => {
                let date = new Date(d + 'T00:00:00Z');
                return date > last;
              });

  dates.forEach(date => {
    response.push(`${date}  ${kt[date]}`);
  });
}


function processAdminMessage(message, msgChannelId) {
  const parts = message.split(' ');
  const cmd = parts[0];
  const name = parts[1];

  if (cmd === 'add') {
    let user = rtm.dataStore.getUserByName(name);
    if (!user) {
      rtm.sendMessage(`failed. unknown user ${name}`, msgChannelId);
      return true;
    }

    config.users[name] = true;
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage('ok', msgChannelId);
    return true;
  }

  if (cmd === 'list') {
    const msg = [];
    for (let user in config.users) {
      msg.push(user);
    }
    rtm.sendMessage(msg.join('\n'), msgChannelId);
    return true;
  }

  if (cmd === 'del') {
    const user = rtm.dataStore.getUserByName(name);
    if (!user) {
      rtm.sendMessage(`failed. unknown user ${name}`, msgChannelId);
      return true;
    }

    delete config.users[name];
    fs.writeFileSync(configName, JSON.stringify(config));
    rtm.sendMessage('ok', msgChannelId);
    return true;
  }
  return false;
}

function getSlackUser(user) {
  const userobj = rtm.dataStore.getUserById(user);
  if (!userobj) {
    return;
  }
  return userobj.name;
}

function getSlackChannel(channelId) {
  const chanobj = rtm.dataStore.getChannelById(channelId);
  if (!chanobj) {
    return;
  }
  return chanobj.name;
}

function isSlackDirectChannel(channelId) {
  return channelId && channelId[0] === 'D';
}

function sendSlackChannelMsg(msg) {
  if (!msg) {
    return;
  }
  rtm.sendMessage(msg, config.slackChannelId);
}

//---------------------------------- SKUD PART -------------------------
function checkUserAtSkud(username, callback){
  const check = spawn('skud', [username]);
  let output = '';

  check.stdout.on('data', (data) => {
    output += data;
  });

  check.stderr.on('data', (data) => {
    output += data;
  });

  check.on('close', (code) => {
    callback(undefined, output);
  });
}


function checkLateUsers(callback) {
  const check = spawn('skud', ['late']);
  let output = '';

  check.stdout.on('data', (data) => {
    output += data;
  });

  check.stderr.on('data', (data) => {
    output += data;
  });

  check.on('close', (code) => {
    let res = checkLateUsersData(output);
    if (res && callback) {
      callback(res);
    }
  });
}

function checkLateUsersData(data) {
  if (!data) {
    return;
  }
  config = JSON.parse(fs.readFileSync(configName));
  let res = [];
  let last = new Date(config.lastTimeLate || 0);
  let maxLateDate = last;
  let records = data.split('\n');

  for (let r of records) {
    let [date, name] = r.split('|');
    if (!date) {
      continue;
    }
    date = new Date(date)
    if (date <= last) {
      continue;
    }
    if (date > maxLateDate) {
      maxLateDate = date;
    }
    res.push(`Приход: ${date.toJSON().slice(11, 19)} ${name}`);
  }

  if (maxLateDate == last) {
    return;
  }

  console.log(new Date().toJSON(), 'Приход:\n', res.length && res.join('\n'));
  config.lastTimeLate = maxLateDate;
  fs.writeFileSync(configName, JSON.stringify(config, null, 2));

  return res.length && res.join('\n');
}

//---------------------------------- KEEPTEAM PART -----------------------------
function keepteamAuth (callback) {
  console.log('keepteam: make auth...');
  delete keepteamHeaders.Cookie;
  const options = {
    url: `https://${KT_HOST}/api/authentication/logon`,
    method: 'POST',
    body: process.env.KT_TOKEN,
    headers: keepteamHeaders
  };

  // console.log(options);
  request(options, function (error, response, body) {
    if (response && response.statusCode == 204) {
      keepteamHeaders.Cookie = response.headers['set-cookie'][0];
      console.log('Session - OK');
      callback();
    } else {
      console.log('keepteam::Auth::error', error, response && response.statusCode);
      callback(error);
    }
  });
}

function keepteamSearchName(name, callback) {
  let options = {
    url: `https://${KT_HOST}/api/employees/suggest`,
    method: 'POST',
    headers: keepteamHeaders,
    body: `{"Filter":{"Name":"${name}"},"Page":{"Size":30,"Number":1},"IsActive":true}`
  };

  ktrequest(options, function (error, response, body) {
    if (response && response.statusCode != 200) {
      console.log('keepteam::SearchName::bad_status', error, response.statusCode);
      callback('wrong_status_code', response.statusCode);
      return;
    }

    try {
      let data = JSON.parse(body);
      let users = data.Result.filter(u => u.IsActive);
      if(users.length == 1) {
        callback(undefined, users[0]);
        return;
      }
      console.log('keepteam::SearchName::info bad result length');
      callback('empty request');
    } catch (e) {
      console.log('keepteam::SearchName::error 2', e, body);
      callback(e);
    }
  });
}

function checkUserAtKeepteam(name, callback){
  keepteamSearchName(name, (err, user) => {
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
  if(!user){
    callback('keepteam::TimeOffs::error nouser');
    return;
  }

  const options = {
    url: `https://${KT_HOST}/api/TimeOffs/List`,
    method: 'POST',
    headers: keepteamHeaders,
    body: `{"Filter":{"Employees":["${user.Id}"],"IsApproved":[],"Date":{},"Types":[],"Departments":[]},"OrderBy":{"ColumnName":"Date","Descending":true},"Page":{"Number":1,"Size":50}}`
  };

  ktrequest(options, (error, response, body) => {
    if (response && response.statusCode != 200) {
      console.log('keepteam::TimeOffs::error', error, response.statusCode);
      callback(error);
      return;
    }

    let data;
    try {
      data = JSON.parse(body).Result;
    } catch (e) {
      console.log('keepteam::TimeOffs::error 2', e, body);
      callback(e);
      return;
    }
    callback(undefined, data);
  });
}

function ktrequest(opts, callback){
  request(opts, (error, response, body) => {
    if (response.statusCode != 200) {
      keepteamAuth(() => {
        request(opts, callback);
      });
      return;
    }
    callback(error, response, body);
  });
}

function keepteamGetFeed(callback){
  const today = new Date().toJSON().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toJSON().slice(0, 10);
  const dayStart = yesterday + 'T00:00:00.000Z';
  const dayEnd = today + 'T59:99:99.999Z';

  const options = {
    url: `https://${KT_HOST}/api/feed/list`,
    method: 'POST',
    headers: keepteamHeaders,
    body: `{"Filter":{"Employees":[],"Date":{Start: "${dayStart}", End: "${dayEnd}"},"Departments":[],"EventTypeCategories":[]},"OrderBy":{"ColumnName":null,"Descending":true},"TimezoneOffset":-180,"Page":{"Number":1,"Size":50}}`
  };

  ktrequest(options, (error, response, body) => {
    if (response && response.statusCode != 200) {
      console.log('keepteam::keepteamGetFeed::error', error, response.statusCode);
      callback(error);
      return;
    }

    let data;
    try {
      data = JSON.parse(body).Result;
    } catch (e) {
      console.log('keepteam::keepteamGetFeed::error 2', e, body);
      callback(e);
      return;
    }
    callback(undefined, data);
  });
}

function keepTeamGetFeedNew(callback) {
  keepteamGetFeed((err, data) => {
    let res = []
    config = JSON.parse(fs.readFileSync(configName));
    let last = new Date(config.lastTimeFeed);
    let maxFeedDate = last;

    for (let e of data) {
      let date = new Date(e.Event.Date);
      if (date <= last || !e.Event.TimeOff) {
        // console.log('skip date', date);
        continue;
      }
      if (e.Event.Type.InternalName !== 'TimeOffAdded') {
        // console.log('skip event', e.Event.Type.InternalName);
        continue;
      }
      if (date > maxFeedDate) {
        maxFeedDate = date;
      }
      let employee = [e.Event.Employee.LastName, e.Event.Employee.FirstName, e.Event.Employee.MiddleName].join(' ');
      let reason = e.Event.Type.Name;
      if (e.Comment) {
        res.push(`Заявка на "${e.Comment}", дней: ${e.Event.TimeOff.Days}, ${employee}`);
      }
    }

    if (maxFeedDate == last) {
      return;
    }

    config.lastTimeFeed = maxFeedDate;
    fs.writeFileSync(configName, JSON.stringify(config, null, 2));
    if (callback && res.length) {
      callback(res.join('\n'));
    }
  });
}

//------------------- Report new events ------------------
setInterval(() => {
  keepTeamGetFeedNew(r => {
    sendSlackChannelMsg(r);
  });
  checkLateUsers(r => {
    sendSlackChannelMsg(r);
  })
}, config.feedCheckInterval);

function formatDate(date){
  return date.toJSON().slice(0,10);
}

function formatTimeOffs(data){
  const detailed = {};
  for (let idx in data) {
    extendTimeOffs(data[idx], detailed);
  }
  return detailed;
}

function extendTimeOffs(elm, target) {
  let date1 = new Date(elm.StartDate);
  let date2 = new Date(elm.EndDate);

  for (; date1 <= date2; date1 = new Date(date1.valueOf() + 86400000)){
    target[formatDate(date1)] = elm.Type.Name;
  }
  return target;
}