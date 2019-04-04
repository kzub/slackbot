/* jshint esnext: true */

const fs = require('fs');
const request = require('request');
const async = require('async');

const configName = process.env.OFFICEBOT_CONFIG;
const KT_HOST = process.env.KT_HOST;
const skudBinary = process.env.SKUDAPP;

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


function keepteamGetEmployees(callback) {
  let options = {
    url: `https://${KT_HOST}/api/employees/listWithColumns`,
    method: 'POST',
    headers: keepteamHeaders,
    body: `	{"Filter":{},"Columns":[
    	{"Order":0,"PermissionName":"Employees.WorkInfo.EmploymentHistory","InternalName":"Department","Id":"c8462779-4ba5-e411-9a13-00155d80001c","Name":"Подразделение"},
    	{"Order":1,"PermissionName":null,"InternalName":"Position","Id":"c9462779-4ba5-e411-9a13-00155d80001c","Name":"Должность"},
    	{"Order":2,"PermissionName":"Employees.WorkInfo.EmploymentHistory","InternalName":"EmploymentDate","Id":"ca462779-4ba5-e411-9a13-00155d80001c","Name":"Дата трудоустройства"}
    ],"Page":{"Number":1,"Size":1000}}`
  };

  ktrequest(options, function (error, response, body) {
    if (response && response.statusCode != 200) {
      console.log('keepteam::keepteamGetEmployees::bad_status', error, response.statusCode);
      callback('wrong_status_code', response.statusCode);
      return;
    }

    try {
      let data = JSON.parse(body);
      console.log(`Found ${data.Items.TotalCount} employees`);

      async.mapLimit(data.Items.Result, 2, keepteamGetEmployeeDetails, function (err, results) {
      	if (err) {
      		console.log('error loading employee details', err);
      		callback(err);
      		return;
      	}
      	callback(undefined, results);
      })
    } catch (e) {
      console.log('keepteam::SearchName::error 2', e, body);
      callback(e);
    }
  });
}

function keepteamGetEmployeeDetails(employee, callback) {
	console.log(`Loading ${employee.FirstName} ${employee.LastName}...`);

	let options = {
    url: `https://${KT_HOST}/api/employees/get/${employee.Id}`,
    headers: keepteamHeaders,
  };

  ktrequest(options, function (error, response, body) {
    if (response && response.statusCode != 200) {
      console.log('keepteam::keepteamGetEmployeeDetails::bad_status', error, response.statusCode);
      callback('wrong_status_code', response.statusCode);
      return;
    }

    try {
      let data = JSON.parse(body);
      callback(undefined, data);
    } catch (e) {
      console.log('keepteam::SearchName::error 2', e, body);
      callback(e);
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

keepteamGetEmployees(function (err, results) {
	if (err) {
		console.log('keepteamGetEmployees', err);
		return;
	}
	fs.writeFileSync('keepteam_data.json', JSON.stringify(results, null, 2));
  console.log('Well done! Use case:')
  console.log(`cat keepteam_data.json | jq '.[]|.Brief.FirstName + " " + .Brief.LastName + "," + .Brief.Department.Name + "," +  .Brief.Position.Name + "," + (.Details.Person.Contacts|reduce .[] as $item (""; . + $item.Value + ","))'`);
});
