const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors')
const express = require('express');
const log = require('./logger').create('MAIN');
const dataExtractor = require('./data_extractor');
const sleep = (ms) => new global.Promise((fulfill) => setTimeout(fulfill, ms)); // eslint-disable-line no-unused-vars

process.on('unhandledRejection', (err) => log.e(err));
process.on('unhandledError', (err) => log.e(err));

//-----------------------------------------
const DB_UPDATE_INTERVAL = 12*60*60*1000;

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

// ============================================================================================================
// DATABASE API
// ============================================================================================================
const db = new sqlite3.Database(process.env.DATABASE_FILE || 'test.sql3');
// db.serialize();

//-----------------------------------------
const promiseSQL = (cmd, query, ...rest) => {
  log.i(`SQL-BEGIN: ${query}`);
  return new global.Promise(function (fulfill, reject){
    db[cmd](query, ...rest, function (err, res){
      if (err) {
        log.e(`SQL-RESULT: ${err} ${JSON.stringify(res, null, 2)} ${this}`);
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

const createTables = async () => {
  // userId, userName, userRealName
  log.i('check table users...');
  await sql.run(`CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY NOT NULL,
    userName TEXT,
    userRealName TEXT
  )`);
  await sql.run(`CREATE UNIQUE INDEX IF NOT EXISTS userId ON users (userId)`);

  log.i('check table channels...');
  await sql.run(`CREATE TABLE IF NOT EXISTS channels (
    channelId TEXT PRIMARY KEY NOT NULL,
    channelName TEXT
  )`);
  await sql.run(`CREATE UNIQUE INDEX IF NOT EXISTS channelId ON channels (channelId)`);

  // date, type, id, mode, data
  log.i('check table rawdata...');
  await sql.run(`CREATE TABLE IF NOT EXISTS rawdata (
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL
  )`);
  await sql.run(`CREATE UNIQUE INDEX IF NOT EXISTS rawindex ON rawdata (date,type,id)`);
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
    // log.i(`insertUser: user already exist ${userId}`);
    return;
  }
  return sql.run(`INSERT INTO users (userId, userName, userRealName) VALUES ('${userId}', '${userName}', '${userRealName}')`);
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

  log.i('transformDate', date, users.length, lastDate);
  for (const id in users) {
    const { userId } = users[id];

    log.i('transformDate read activity', date, userId, id, `${Math.floor(100 * id / users.length)}%`);
    const dayData = await sql.all(`SELECT ts, userPresence FROM activity WHERE userId = '${userId}' AND strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) = '${date}' ORDER BY ts ASC`);
    const dayActivity = transformRawActivity(dayData);

    if (dayActivity.length !== 1) {
      log.e(`transformDate to many results for one date ${date}, ${JSON.stringify(dayActivity)}`);
      return;
    }
    const resultActivity = dayActivity[0].activity;

    try {
      await sql.run(`BEGIN`);

      log.i('transformDate delete today stats', date, userId);
      await sql.run(`DELETE FROM stats WHERE userId = '${userId}' AND date = '${date}'`);

      log.i('transformDate write new stats', date, userId);
      const insertQuery = `INSERT INTO stats (userId,date,${getStatColumns().join()}) VALUES ('${userId}','${date}',${resultActivity.join()})`;
      const queryResult = await sql.run(insertQuery);
      if (queryResult.changes !== 1) {
        await sql.run(`ROLLBACK`);
        log.e(`transformDate incorrect results for stat insert ${insertQuery}`);
        return;
      }

      if (!lastDate) {
        log.i('transformDate remove processed activity', date, userId);
        const deleteQuery = `DELETE FROM activity WHERE userId = '${userId}' AND strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) = '${date}'`;
        const delQueryResult = await sql.run(deleteQuery);
        if (!delQueryResult.changes) {
          await sql.run(`ROLLBACK`);
          log.e(`transformDate incorrect results for activity delete: ${deleteQuery}`);
          return;
        }
      }
      await sql.run(`COMMIT`);
    }
    catch (err) {
      log.e(`transformDate unexpected: ${err}`);
      await sql.run(`ROLLBACK`);
    }
  }

  return 'ok';
};

//-----------------------------------------
const transformLog = async () => {  // eslint-disable-line no-unused-vars
  log.i(`transformLog BEGIN`);
  try {
    const dates = await sql.all(`SELECT DISTINCT strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) date FROM activity ORDER BY date ASC`);
    for (const id in dates) {
      const res = await transformDate(dates[id], (Number(id)== dates.length - 1));
      if (!res) {
        log.e(`transformLog stop processing`);
        return;
      }
    }
  }
  catch (err) {
    log.e(`transformLog unexpected: ${err}`);
  }
  log.i(`transformLog END`);
};


const loadDataFromSlack = async () => {

  log.i('ok');s
  await dataExtractor.extract();
};

// ============================================================================================================
// Web API
// ============================================================================================================
const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static(process.env.WEB_ROOT));

//-----------------------------------------
app.get('/user/:userId/:from/:to/', async (req, res) => {
  log.i('HTTP', req.url, req.ip, req.params);
  const { userId, from, to } = req.params;
  const data = await getUserActivity({ from, to, userId });
  res.json({ ok: true, userId, data });
});

//-----------------------------------------
app.get('/activity/:from/:to', async (req, res) => {
  log.i('HTTP', req.url, req.ip, req.params);
  const { from, to } = req.params;
  const data = await getUsersActivity({ from, to });
  res.json({ ok: true, data });
});

//-----------------------------------------
app.get('/*', (req, res) => {
  log.i('HTTP unknown get request:', req.url, req.ip);
  res.json({ ok: true });
});
app.post('/*', (req, res) => {
  log.i('HTTP unknown post request:', req.url, req.ip);
  res.json({ ok: true });
});


// ============================================================================================================
// init
// ============================================================================================================

//-----------------------------------------
(async function init () {
  log.i('tables...');
  await createTables();

  log.i('network...');
  const { host, port } = process.env;
  if (!host || !port) {
    log.e('Express no host/port specified');
    process.exit();
  }
  app.listen(port, host, () => {
    log.i(`Express listening on port ${host}:${port}`);
  });

  log.i('update database...');
  setInterval(loadDataFromSlack, DB_UPDATE_INTERVAL);
  loadDataFromSlack();
})();







