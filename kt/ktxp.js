/* jshint esnext: true */

const fs = require('fs');
const zlib = require('zlib');
const request = require('request');
const async = require('async');

const KT_HOST = process.env.KT_HOST;

if (!KT_HOST) {
  console.log('No KT_HOST');
  process.exit();
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


function keepteamGetEmployees(callback) {
  let options = {
    url: `https://${KT_HOST}/api/employees/listWithColumns`,
    method: 'POST',
    headers: keepteamHeaders,
    body: ` {"Filter":{},"Columns":[
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

  keepteamGetEmployeePhoto(employee);

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
      console.log('keepteam::keepteamGetEmployeeDetails::error 2', e, body);
      callback(e);
    }
  });
}

function keepteamGetEmployeePhoto(employee) {
  if (!employee.PhotoId) {
    console.log(`--- No photo for ${employee.FirstName} ${employee.LastName}`);
    return;
  }
  // console.log(`Fetching ${employee.FirstName} ${employee.LastName} photo...`);

  let options = {
    url: `https://${KT_HOST}/api/Photo?uid=${employee.PhotoId}&height=216&width=216`,
    headers: keepteamHeaders,
    encoding: null,
  };

  ktrequest(options, function (error, response, body) {
    if (response && response.statusCode != 200) {
      console.log('keepteam::keepteamGetEmployeePhoto::bad_status', error, response.statusCode, options.url);
      return;
    }

    try {
      fs.writeFileSync(`photos/${employee.Id}.jpg`, response.body, { encoding: 'binary' });
    } catch (e) {
      console.log('keepteam::keepteamGetEmployeePhoto::error 2', e, body);
    }
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


keepteamGetEmployees(function (err, results) {
  if (err) {
    console.log('keepteamGetEmployees', err);
    return;
  }
  fs.writeFileSync('keepteam_data.json', JSON.stringify(results, null, 2));
  console.log('Well done! Use case:')
  console.log(`cat keepteam_data.json | jq '.[]|.Brief.FirstName + " " + .Brief.LastName + "," + .Brief.Department.Name + "," +  .Brief.Position.Name + "," + (.Details.Person.Contacts|reduce .[] as $item (""; . + $item.Value + ","))'`);
});
