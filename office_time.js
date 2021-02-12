/* jshint esnext: true */

const async = require('async');
const bodyParser = require('body-parser');
const cors = require('cors')
const express = require('express');
const fs = require('fs');
const request = require('request');
const slack = require('@slack/rtm-api');
const { spawn } = require('child_process');

const configName = process.env.OFFICEBOT_CONFIG;
const KT_HOST = process.env.KT_HOST;
const skudBinary = process.env.SKUDAPP;

if (!KT_HOST) {
  console.log('No KT_HOST');
  process.exit();
}

let config = JSON.parse(fs.readFileSync(configName));

process.on('unhandledRejection', function(reason, p){
   console.log('unhandledRejection', reason, p);
});

process.on('uncaughtException', function(error) {
       console.log('uncaughtException', error);
});


// --------------------------------------------------------------------------------
// api gateway for bo monitor
// --------------------------------------------------------------------------------
const app = express();
const { host, port } = process.env;
if (!host || !port) {
  console.log('No host/port');
  process.exit();
}
app.use(bodyParser.json());
app.use(cors());
app.listen(port, host, () => {
  console.log(`Listening on port ${host}:${port}!`);
});

function isGoodDate(date) {
  return !isNaN(new Date(date).valueOf());
}

app.post('/timeoffs', (req, res) => {
  console.log('request: /timeoffs', req.ip, req.body);
  let { startDate, endDate } = req.body;

  if (!isGoodDate(startDate) || !isGoodDate(endDate)) {
    console.log('ERROR: bad date format');
    res.status(400).json({ error: 'bad date format'});
    return;
  }

  keepteamTimeOffs({
    startDate,
    endDate,
  }, function (err, data) {
    // console.log(err, data)
    const response = data.map(e => {
      return {
        name: [e.Employee.FirstName,e.Employee.LastName].join(' '),
        startDate: e.StartDate,
        endDate:e.EndDate,
        type: e.Type.Name
      }
    });

    response.sort((a, b) => {
      if (a.name == b.name) { return 0;}
      return a.name > b.name ? 1 : -1;
    });

    res.json(response);
  })
});

app.get('/*', (req, res) => {
  console.log('get request:', req.url, req.ip);
  res.json({ ok: true });
});

app.post('/*', (req, res) => {
  console.log('post request:', req.url, req.ip);
  res.json({ ok: true });
});
// --------------------------------------------------------------------------------

const keepteamHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Accept': 'application/json, text/plain, */*',
  'Referer': `https://${KT_HOST}/`,
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36',
};

//---------------------------------- SLACK BOT -----------------------------
const rtm = new slack.RTMClient(process.env.SLACK_API_TOKEN, {
  logLevel: slack.LogLevel.INFO,
  logger: {
    debug: (...msgs) => { console.log(`RTM[DEBUG]: ${JSON.stringify(msgs)}`); },
    info: (...msgs) =>  { console.log(`RTM[INFO]: ${JSON.stringify(msgs)}`);  },
    warn: (...msgs) =>  { console.log(`RTM[WARN]: ${JSON.stringify(msgs)}`);  },
    error: (...msgs) => { console.log(`RTM[ERROR]: ${JSON.stringify(msgs)}`); },
    setLevel: () => { },
    setName:  () => { },
  },
  clientPingTimeout: 120000,
  serverPongTimeout: 60000,
});

rtm.start();
rtm.on('connected', () => {
  console.log('RTM client authenticated!', new Date());
});

// -----------------------------------------------------------
async function getSlackUser(userId) {
  const res = await rtm.webClient.users.info({ user: userId });
  if (!res.ok) {
    return null;
  }
  return res.user.name;
}
// -----------------------------------------------------------
async function getSlackUserByName(name) {
  let oneMoreStep = true;
  let members = [];

  for (let res ; oneMoreStep == true;) {
    res = await rtm.webClient.users.list({
      // limit: 500,
      cursor:  res && res.response_metadata.next_cursor
    });
    if (!res.ok) {
      return null;
    }
    members = members.concat(res.members);
    // console.log(res.members.length, res.response_metadata.next_cursor, oneMoreStep)
    oneMoreStep = res.response_metadata.next_cursor && res.response_metadata.next_cursor.length > 0;
  }

  // console.log(`TOTAL USERS: ${members.length}`);
  const user = members.filter(m => m.name == name).pop();
  return user && user.id;
}

// -----------------------------------------------------------
rtm.on('message', async (message) => {
  try {
    if (!message.user || !message.text) {
      return;
    }
    const slackuser = await getSlackUser(message.user);
    if (!slackuser) {
      console.log('error getting slackuser', message);
      return;
    }
    if (isMyself(message.user)) {
      return;
    }
    const direct = isSlackDirectChannel(message.channel);
    if (!direct) {
      // not direct message
      return;
    }

    if (config.admins[slackuser] && (await processAdminMessage(message.text, message.channel))) {
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

// -----------------------------------------------------------
function processUserMessage(message, msgChannelId) {
  async.parallel([
    (cb) => {
      checkUserAtSkud(message, cb);
    },
    (cb) => {
      if (message === 'today' || message === 'сегодня') {
        cb(undefined, {});
        return;
      }

      checkUserAtKeepteam(message, (err, res) => {
        cb(undefined, res);
      });
    }
  ], (err, result) =>{
    if(err){
      console.log('processUserMessage::error', err);
      return;
    }
    let response = [];
    let skud = result[0];
    let kt = result[1] || {};

    if(!skud.length){
      rtm.sendMessage('Не найдено. Имена и фамилии, пишутся с большой буквы.', msgChannelId);
      return;
    }

    let lines = skud.split('\n');
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

    while (response.length) {
      let res = response.splice(0, 200);
      rtm.sendMessage('```' + res.join('\n') + '```', msgChannelId);
    }
  });
}

// -----------------------------------------------------------
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

// -----------------------------------------------------------
async function processAdminMessage(message, msgChannelId) {
  const parts = message.split(' ');
  const cmd = parts[0];
  const name = parts[1];

  if (cmd === 'add') {
    let user = await getSlackUserByName(name);
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
    rtm.sendMessage(msg.join('\n') || 'empty', msgChannelId);
    return true;
  }

  if (cmd === 'del') {
    const user = getSlackUserByName(name);
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

// -----------------------------------------------------------
function isMyself(userId) {
  return userId === config.botUserId;
}

// -----------------------------------------------------------
function isSlackDirectChannel(channelId) {
  return channelId && channelId[0] === 'D';
}

// -----------------------------------------------------------
function sendSlackChannelMsg(msg) {
  if (!msg) {
    return;
  }
  rtm.sendMessage(msg, config.slackChannelId);
}

//---------------------------------- SKUD PART -------------------------
function checkUserAtSkud(username, callback){
  const check = spawn(skudBinary, [username]);
  let output = '';

  check.stdout.on('data', (data) => {
    output += data;
  });

  check.stderr.on('data', (data) => {
    output += data;
  });

  check.on('close', (/*code*/) => {
    callback(undefined, output);
  });
}

// -----------------------------------------------------------
function checkLateUsers(callback) {
  const check = spawn(skudBinary, ['arrived']); // не опоздавшие, а просто по мере прихода
  let output = '';

  check.stdout.on('data', (data) => {
    output += data;
  });

  check.stderr.on('data', (data) => {
    output += data;
  });

  check.on('close', (/*code*/) => {
    let res = checkLateUsersData(output);
    if (res && callback) {
      callback(res);
    }
  });
}

// -----------------------------------------------------------
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
  request(options, function (error, response) {
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

// -----------------------------------------------------------
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

// -----------------------------------------------------------
function checkUserAtKeepteam(name, callback){
  keepteamSearchName(name, (err, user) => {
    if(err){
      callback(err);
      return;
    }
    if(!user){
      callback('keepteam::keepteamSearchName::error no_user');
      return;
    }
    keepteamTimeOffs({ userId: user.Id }, (err, data) => {
      if(err){
        callback(err);
        return;
      }
      // console.log(data);
      callback(undefined, formatTimeOffs(data));
    });
  });
}

// -----------------------------------------------------------
function keepteamTimeOffs(params, callback) {
  const employees = params.userId || '';
  let dateFilters = '';
  if (params.startDate && params.endDate) {
    dateFilters = `"Start": "${params.startDate}", "End": "${params.endDate}"`;
  }
  const options = {
    url: `https://${KT_HOST}/api/TimeOffs/List`,
    method: 'POST',
    headers: keepteamHeaders,
    body: `{"Filter":{"Employees":[${employees}],"IsApproved":[],"Date":{${dateFilters}},"Types":[],"Departments":[]},"OrderBy":{"ColumnName":"Date","Descending":true},"Page":{"Number":1,"Size":1000}}`
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
    } catch (err) {
      console.log('keepteam::TimeOffs::error 2', err, body);
      callback(err);
      return;
    }
    callback(undefined, data);
  });
}

// -----------------------------------------------------------
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

// -----------------------------------------------------------
function keepteamGetFeed(callback){
  const today = new Date().toJSON().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toJSON().slice(0, 10);
  const dayStart = yesterday + 'T00:00:00.000Z';
  const dayEnd = today + 'T59:99:99.999Z';

  const options = {
    url: `https://${KT_HOST}/api/feed/list`,
    method: 'POST',
    headers: keepteamHeaders,
    body: `{"Filter":{"Employees":[],"Date":{Start: "${dayStart}", End: "${dayEnd}"},"Departments":[],"EventTypeCategories":[]},"OrderBy":{"ColumnName":null,"Descending":true},"TimezoneOffset":-180,"Page":{"Number":1,"Size":500}}`
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

// -----------------------------------------------------------
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

// -----------------------------------------------------------
function formatDate(date){
  return date.toJSON().slice(0,10);
}

// -----------------------------------------------------------
function formatTimeOffs(data){
  const detailed = {};
  for (let idx in data) {
    extendTimeOffs(data[idx], detailed);
  }
  return detailed;
}

// -----------------------------------------------------------
function extendTimeOffs(elm, target) {
  let date1 = new Date(elm.StartDate);
  let date2 = new Date(elm.EndDate);

  for (; date1 <= date2; date1 = new Date(date1.valueOf() + 86400000)){
    target[formatDate(date1)] = elm.Type.Name;
  }
  return target;
}