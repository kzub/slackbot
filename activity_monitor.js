const slack = require('@slack/rtm-api');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors')
const express = require('express');
const tests = require('./activity/activity_mon_test');
const sleep = (ms) => new global.Promise((fulfill) => setTimeout(fulfill, ms)); // eslint-disable-line no-unused-vars

//-----------------------------------------
const TIMEZONE_OFFSET = 3*60*60*1000; // Moscow time
const MON_INTERVAL = 5*60*1000;
const MON_INTERVAL_COUNT = 24*60*60*1000 / MON_INTERVAL;  // 5 minutes intervals in 0..24h => 1..288
const DB_UPDATE_INTERVAL = MON_INTERVAL * 12; // hourly

const getCurrentTimestamp = () => {
  return Date.now() + TIMEZONE_OFFSET;
};

const getDateObj = (ts) => {
  return new Date(ts);
};

const getDate = (ts) => {
  return getDateObj(ts).toJSON().slice(0, 10);
};

const getDateAndTime = (ts) => {
  return getDateObj(ts).toJSON().slice(0, 19);
};

// GMT 20 21 22 23 00 01 02 03 04 05 .. 20 21 22 23 00
// MSK 23 00 01 02 03 04 05 06 07 08 .. 23 00 01 02 03

const getMonitoringIntervalNum = (ts) => {
  if (!ts) { throw new Error('getMonitoringIntervalNum: no ts'); }
  const dateTs = ts*1000;
  const dateStart = getDateObj(dateTs);
  dateStart.setUTCHours(0);
  dateStart.setUTCMinutes(0);
  dateStart.setUTCSeconds(0);
  dateStart.setUTCMilliseconds(0);
  const dayStartTs = dateStart.valueOf();
  const intervalNum = Math.floor((dateTs - dayStartTs) / (5*60*1000));
  return intervalNum;
}

const log = (...rest) => {
  console.log(getDateAndTime(getCurrentTimestamp()), ...rest);
};

// ============================================================================================================
// DATABASE API
// ============================================================================================================
const db = new sqlite3.Database(process.env.DATABASE_FILE);
// db.serialize();

//-----------------------------------------
const promiseSQL = (cmd, query, ...rest) => {
  log(`SQL-BEGIN: ${query}`);
  return new global.Promise(function (fulfill, reject){
    db[cmd](query, ...rest, function (err, res){
      if (err) {
        log(`Error: SQL-RESULT: ${err} ${JSON.stringify(res, null, 2)} ${this}`);
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

const getStatColumns = (prefix = '', suffix = '') => {
  const columns = [];
  for (let i = 0; i < MON_INTERVAL_COUNT; i++) {
    columns.push(`${prefix}c${i}${suffix}`);
  }
  return columns
};

const createTables = async () => {
  // userId, userName, userRealName
  log('check table users...');
  await sql.run(`CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY NOT NULL,
    userName TEXT,
    userRealName TEXT
  )`);
  await sql.run(`CREATE UNIQUE INDEX IF NOT EXISTS userId ON users (userId)`);

  // ts, userId, userPresence
  log('check table activity...');
  await sql.run(`CREATE TABLE IF NOT EXISTS activity (
    ts INTEGER NOT NULL,
    userId TEXT NOT NULL,
    userPresence INTEGER NOT NULL
  )`);

  // userId, date, c0,c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11,c12,...........,c286,c287;
  log('check table stats...')
  await sql.run(`CREATE TABLE IF NOT EXISTS stats (
    userId TEXT NOT NULL,
    date text NOT NULL,
    ${getStatColumns('', ' INTEGER NOT NULL').join()}
  )`);

  log('check table stats index...');
  await sql.run(`CREATE UNIQUE INDEX IF NOT EXISTS userdate ON stats (userId, date)`);
};

//-----------------------------------------
const insertActivity = async ({ presence, userId }) => {
  const ts = Math.floor(getCurrentTimestamp() / 1000);
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
const transformRawActivity = (allData) => {
  const map = {};
  for (let row of allData) {
    const ts = row.ts * 1000;
    const date = getDate(ts);
    map[date] = map[date] || [];
    map[date].push(row);
  }

  const result = [];
  const currentTs = getCurrentTimestamp();
  const currentDate = getDate(currentTs);
  const currentIntervalNum = getMonitoringIntervalNum(currentTs/1000);
  // console.log(currentTs, currentDate, currentIntervalNum);

  for (let date of Object.keys(map)) {
    const dateRows = map[date];
    let currentRow = 0;
    let intervalLastState = 0;
    const row = {
      date: date,
      activity: [],
    };

    for (let i = 0; i < MON_INTERVAL_COUNT; i++) {
      let found = false;

      // console.log('-', date, i, currentRow, dateRows.length, dateRows[currentRow] && dateRows[currentRow].ts, dateRows[currentRow] && dateRows[currentRow].userPresence, intervalLastState, currentRow < dateRows.length ? getMonitoringIntervalNum(dateRows[currentRow].ts) : '-');
      while ((currentRow < dateRows.length) && getMonitoringIntervalNum(dateRows[currentRow].ts) === i) {
        intervalLastState = dateRows[currentRow].userPresence; // save state for future intervals
        // console.log('W', date, i, currentRow, dateRows.length, dateRows[currentRow].ts, dateRows[currentRow].userPresence, intervalLastState, getMonitoringIntervalNum(dateRows[currentRow].ts));
        if (intervalLastState > 0) {
          row.activity[i] = intervalLastState;
          found = true;
        }
        currentRow++;
      }

      if (date === currentDate && i > currentIntervalNum) {
        row.activity[i] = 0; // future
        continue;
      }

      if (!found) {
        row.activity[i] = intervalLastState;
      }
    }

    result.push(row);
    // console.log(date, row.activity.length, row.activity.join(''));
  }

  return result;
}
// userId, userName, userRealName
// ts, userId, userPresence
// userId, date, 1,2,3,4,5,6,7,8,9,10,11,12,...........,286,287,288
//-----------------------------------------
const weekDays = ['sun', 'mon', 'tue', 'wed', 'thur', 'fri', 'sat'];
const mapHistoryStat = (stat) => {
  const columns = getStatColumns();
  const dayNum = (new Date(stat.date)).getDay();
  const weekDay = weekDays[dayNum];
  const row = {
    date: stat.date,
    weekDay,
    weekend : (dayNum == 0 || dayNum == 6),
    activity: [],
  };
  for (const c of columns) {
    row.activity.push(stat[c]);
  }
  return row;
};

const mapPerUserStat = (stat) => {
  const columns = getStatColumns();
  const row = {
    userId: stat.userId,
    userSum: stat.userSum,
    userDays: stat.days,
    activity: [],
  };
  for (const c of columns) {
    row.activity.push(Number((stat[c]/stat.days).toFixed(2)));
  }

  return row;
};

//-----------------------------------------
const getUser = async ({ userId }) => {
  const matchedUsers = await sql.all(`SELECT * FROM users WHERE userId = '${userId}'`);
  return matchedUsers[0];
};

//-----------------------------------------
const getUserActivity = async ({ from, to, userId }) => {
  const user = await getUser({ userId });
  const historyStat = await sql.all(`SELECT * FROM stats WHERE
    userId = '${userId}'
    AND datetime('${from}') <= datetime(date) AND datetime(date) <= datetime('${to}')
    ORDER BY date DESC`);

  const result = historyStat
                  .map(mapHistoryStat)
                  .map(row => { return {
                    ...row,
                    ...user,
                  }} )
  return result;
};

//-----------------------------------------
const getUsersActivity = async ({ from, to }) => {
  const users = (await sql.all(`SELECT * FROM users`))
    .reduce((res, item) => {
      res[item.userId] = item;
      return res;
    }, {});
  const columns = getStatColumns();
  const colSum = columns.map(c => `SUM(${c}) ${c}`);
  const userSum = columns.reduce((res, col) => res + `+${col}`, 'SUM(0') + ')';
  const usersStat = await sql.all(`SELECT
    userId, COUNT(1) days, ${userSum} userSum, ${colSum.join()}
    FROM stats
    WHERE datetime('${from}') <= datetime(date) AND datetime(date) <= datetime('${to}')
    GROUP BY userId
    ORDER BY userSum DESC
  `);

  const result = usersStat
                  .map(mapPerUserStat)
                  .map(user => { return {
                    ...user,
                    ...users[user.userId],
                  }} )
  return result;
};

//-----------------------------------------
const transformDate = async ({date}, lastDate) => {
  const users = await sql.all(`SELECT DISTINCT userId FROM activity WHERE strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) = '${date}'`);

  log('transformDate', date, users.length, lastDate);
  for (const id in users) {
    const { userId } = users[id];

    log('transformDate read activity', date, userId, id, `${Math.floor(100 * id / users.length)}%`);
    const dayData = await sql.all(`SELECT ts, userPresence FROM activity WHERE userId = '${userId}' AND strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) = '${date}' ORDER BY ts ASC`);
    const dayActivity = transformRawActivity(dayData);

    if (dayActivity.length !== 1) {
      log(`Error: transformDate to many results for one date ${date}, ${JSON.stringify(dayActivity)}`);
      return;
    }
    const resultActivity = dayActivity[0].activity;

    try {
      await sql.run(`BEGIN`);

      if (lastDate) {
        log('transformDate delete today stats', date, userId);
        await sql.run(`DELETE FROM stats WHERE userId = '${userId}' AND date = '${date}'`);
      }

      log('transformDate write new stats', date, userId);
      const insertQuery = `INSERT INTO stats (userId,date,${getStatColumns().join()}) VALUES ('${userId}','${date}',${resultActivity.join()})`;
      const queryResult = await sql.run(insertQuery);
      if (queryResult.changes !== 1) {
        await sql.run(`ROLLBACK`);
        log(`Error: transformDate incorrect results for stat insert ${insertQuery}`);
        return;
      }

      if (!lastDate) {
        log('transformDate remove processed activity', date, userId);
        const deleteQuery = `DELETE FROM activity WHERE userId = '${userId}' AND strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) = '${date}'`;
        const delQueryResult = await sql.run(deleteQuery);
        if (!delQueryResult.changes) {
          await sql.run(`ROLLBACK`);
          log(`Error: transformDate incorrect results for activity delete: ${deleteQuery}`);
          return;
        }
      }
      await sql.run(`COMMIT`);
    }
    catch (err) {
      log(`Error: transformDate unexpected: ${err}`);
      await sql.run(`ROLLBACK`);
    }
  }

  return 'ok';
};

//-----------------------------------------
const transformLog = async () => {  // eslint-disable-line no-unused-vars
  log(`transformLog BEGIN`);
  const dates = await sql.all(`SELECT DISTINCT strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) date FROM activity ORDER BY date ASC`);
  for (const id in dates) {
    const res = await transformDate(dates[id], (Number(id)== dates.length - 1));
    if (!res) {
      log(`Error: transformLog stop processing`);
      return;
    }
  }
  log(`transformLog END`);
};

// ============================================================================================================
// SLACK API
// ============================================================================================================
let members = {};
const rtm = new slack.RTMClient(process.env.SLACK_API_TOKEN, { logLevel: slack.LogLevel.INFO });

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
    log(`Error: presence_change unknown userId ${userId}`);
    return;
  }

  await insertActivity({ userId, presence })
  log(`presence_change ${user.name} (${user.real_name}): ${presence}`);
});

// ============================================================================================================
// Web API
// ============================================================================================================
const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static(process.env.WEB_ROOT));

//-----------------------------------------
app.get('/user/:userId/:from/:to/', async (req, res) => {
  log('HTTP', req.url, req.ip, req.params);
  const { userId, from, to } = req.params;
  const data = await getUserActivity({ from, to, userId });
  res.json({ ok: true, userId, data });
});

//-----------------------------------------
app.get('/activity/:from/:to', async (req, res) => {
  log('HTTP', req.url, req.ip, req.params);
  const { from, to } = req.params;
  const data = await getUsersActivity({ from, to });
  res.json({ ok: true, data });
});

//-----------------------------------------
app.get('/*', (req, res) => {
  log('HTTP unknown get request:', req.url, req.ip);
  res.json({ ok: true });
});
app.post('/*', (req, res) => {
  log('HTTP unknown post request:', req.url, req.ip);
  res.json({ ok: true });
});


// ============================================================================================================
// init
// ============================================================================================================
const reSubscribeOnDayStart = () => { // eslint-disable-line no-unused-vars
  if (getMonitoringIntervalNum(getCurrentTimestamp()) == 0) { // 0 - first day interval
    subscribe(); // update new members dayly
  }
};

//-----------------------------------------
(async function init () {
  log('tests...');
  tests.run({ transformRawActivity, getMonitoringIntervalNum });
  log('tables...');
  await createTables();
  log('slack...');
  if (!process.env.SLACK_API_TOKEN) {
    log('Error: slack rtm api no token');
    process.exit();
  }
  // log("!!!!! MONITORING DISABLED !!!!")
  rtm.start();
  setInterval(reSubscribeOnDayStart, MON_INTERVAL);
  log('network...');
  const { host, port } = process.env;
  if (!host || !port) {
    log('Error: Express no host/port specified');
    process.exit();
  }
  app.listen(port, host, () => {
    log(`Express listening on port ${host}:${port}`);
  });
  log('update database...');
  setInterval(transformLog, DB_UPDATE_INTERVAL);
  transformLog();
})();







