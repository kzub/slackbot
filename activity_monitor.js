const slack = require('@slack/rtm-api');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors')
const express = require('express');

const db = new sqlite3.Database('user_activity.sql3');
const rtm = new slack.RTMClient(process.env.SLACK_API_TOKEN, { logLevel: slack.LogLevel.INFO });
let members;

//-----------------------------------------
const log = (...rest) => {
  console.log((new Date()).toJSON().slice(0, 19), ...rest);
};

if (!process.env.SLACK_API_TOKEN) {
  log('slack rtm api error: no token');
  process.exit();
}

//-----------------------------------------
db.serialize();
db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY NOT NULL,
  userName TEXT,
  userRealName TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS activity (
  ts INTEGER NOT NULL,
  userId TEXT NOT NULL,
  userPresence INTEGER NOT NULL
)`);

//-----------------------------------------
const promiseSQL = (cmd, query, ...rest) => {
  log(`SQL-BEGIN: ${query}`);
  return new global.Promise(function (fulfill, reject){
    db[cmd](query, ...rest, function (err, res){
      if (err) {
        log(`SQL-RESULT: ${err} ${JSON.stringify(res, null, 2)} ${this}`);
        reject(err);
      }
      else fulfill({
        statement: this,
        result: res,
      });
    });
  });
};

const sql = {
  run: async (...rest) => (await promiseSQL('run', ...rest)).statement,
  all: async (...rest) => (await promiseSQL('all', ...rest)).result,
};

//-----------------------------------------
const insertActivity = async ({ presence, userId }) => {
  const ts = Math.floor(Date.now() / 1000);
  let userPresence;
  switch(presence) {
    case 'away': userPresence = 0; break;
    case 'active': userPresence = 1; break;
    default: userPresence = -1;
  }
  return sql.run(`INSERT INTO activity (ts, userId, userPresence) VALUES (${ts}, '${userId}', ${userPresence})`);
};

//-----------------------------------------
const insertUser = async ({ userId, userName, userRealName }) => {
  const res = await sql.all(`SELECT * from users WHERE userId = '${userId}'`);
  if (res && res.length > 0) {
    log(`insertUser: user already exist ${userId}`);
    return;
  }
  return sql.run(`INSERT INTO users (userId, userName, userRealName) VALUES ('${userId}', '${userName}', '${userRealName}')`);
};

//-----------------------------------------
const subscribe = async () => {
  log(`subscribe: fetching active users for: ${rtm.activeTeamId}`);
  const usersList = await rtm.webClient.users.list({team_id: rtm.activeTeamId });
  const users = usersList.members.filter(user => !user.deleted && !user.is_bot && !user.is_restricted);

  log(`subscribe: found ${users.length} users`);
  members = {};
  users.forEach(user => {
    insertUser({
      userId: user.id,
      userName: user.name,
      userRealName: user.real_name,
    });
    members[user.id] = user;
  });

  await rtm.subscribePresence(users.map(user => user.id));
  log('subscribe: ok');
}

//-----------------------------------------
rtm.on('connected', async () => {
  log(`RTM client connected! userId: ${rtm.activeUserId}, teamId: ${rtm.activeTeamId}`);
  subscribe();
});

//-----------------------------------------
rtm.on('reconnecting', async () => {
  log('RTM client RECONNECTING!');
});

//-----------------------------------------
rtm.on('presence_change', async (event) => {
  const { user: userId, presence } = event;
  const user = members[userId];
  if (!user) {
    log(`presence_change error: unknown userId ${userId}`);
    return;
  }

  await insertActivity({ userId, presence })
  log(`presence_change ${user.name} (${user.real_name}): ${presence}`);
});

//-----------------------------------------
rtm.start();
setInterval(subscribe, 24*60*60*1000);

//-----------------------------------------------------------
async function getSlackChannelByName(name) { // eslint-disable-line no-unused-vars
  let oneMoreStep = true;
  let channels = [];
  for (let res ; oneMoreStep == true;) {
    res = await rtm.webClient.channels.list({
      exclude_archived: true,
      cursor:  res && res.response_metadata.next_cursor
    });
    if (!res.ok) {
      return null;
    }
    channels = channels.concat(res.channels);
    oneMoreStep = res.response_metadata.next_cursor && res.response_metadata.next_cursor > 0;
  }

  // log(`TOTAL CHANNELS: ${channels.length}`);
  const channel = channels.filter(m => m.name == name).pop();
  return channel && channel.id;
}

//-----------------------------------------------------------
async function getSlackUser(userId) { // eslint-disable-line no-unused-vars
  const res = await rtm.webClient.users.info({ user: userId });
  if (!res.ok) {
    return null;
  }
  return res.user.name;
}


// Web API -----------------------------------------
// =================================================
/*
const app = express();
const { host, port } = process.env;
if (!host || !port) {
  log('Express error: No host/port specified');
  process.exit();
}
app.use(bodyParser.json());
app.use(cors());
app.listen(port, host, () => {
  log(`Express listening on port ${host}:${port}.`);
});

//-----------------------------------------
app.get('/*', (req, res) => {
  console.log('get request:', req.url, req.ip);
  res.json({ ok: true });
});

*/










