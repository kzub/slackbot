console.log('starting...')
const fs = require('fs')

let counter = 0;

const main = async () => {
	const raw = fs.readFileSync('keepteam_data.json');
	const data = JSON.parse(raw)
		.filter(info => info.Brief.IsActive);

	const managers = {};
	const employees = {};

	let generalManager;

	data.forEach(emp => {
		employees[emp.Brief.Id] = emp;

		const manager = emp.Details.WorkInfo.EmploymentHistory.slice(-1).pop().Manager;
		if (manager) {
			managers[manager.Id] = managers[manager.Id] || [];
			managers[manager.Id].push(emp.Brief.Id);
		} else {
			console.log(`${emp.Brief.LastName} has no manager!`);
			generalManager = emp.Brief.Id;
		}
	})

	console.log(data.length);
	// console.log(Object.entries(managers).map(([k, v]) => `${employees[k].Brief.LastName} -> ${ v.map(eId => employees[eId].Brief.LastName)}`));

	const org = buildNode(employees, managers, generalManager);
	console.log(counter, org)

	fs.writeFileSync('keepteam_graph.json', JSON.stringify(org, null, 2));
	// Object.entries(managers).forEach(([managerId, subordinateIds]) => {	
	// });
	// const employees = data.filter()
};


function buildNode(employees, managers, employeeId) {
	const employee = employees[employeeId];
	const subordinateIds = managers[employeeId];
	counter++
	if (!subordinateIds) {
		return {
			id: employee.Brief.Id,
			name: employee.Brief.LastName,
		};
	}

	return {
		id: employee.Brief.Id,
		name: employee.Brief.LastName,
		children: subordinateIds.map(subId => buildNode(employees, managers, subId))
	}
}


main().catch(err => {
	console.log(err)
});


/*
{
  "Brief": {
    "Id": "6c6adb25-db20-ea11-80c1-0025909368bb",
    "FirstName": "Ринат",
    "MiddleName": "Ильнурович",
    "LastName": "Абайдулин",
    "IsActive": true,
    "Position": {
      "Id": "84b01104-370d-e711-80be-0025909368bb",
      "Name": "Специалист по контрактингу отелей"
    },
    "Department": {
      "Id": "0f22bfc3-340b-e711-80be-0025909368bb",
      "Name": "Отдел по работе с отелями. B2B Департамент"
    },
    "WorkStatus": {
      "Id": "f9c25ba2-b2ca-e311-b4d8-00155d801b09",
      "Name": "Полная занятость"
    },
    "PhotoId": "399e0029-c326-44ab-bc8a-d89864141f92",
    "User": null
  },
  "Details": {
    "Id": "6c6adb25-db20-ea11-80c1-0025909368bb",
    "PhotoId": "399e0029-c326-44ab-bc8a-d89864141f92",
    "Person": {
      "Id": "6c6adb25-db20-ea11-80c1-0025909368bb",
      "GeneralInfo": {
        "Id": "6c6adb25-db20-ea11-80c1-0025909368bb",
        "LastName": "Абайдулин",
        "FirstName": "Ринат",
        "MiddleName": "Ильнурович",
        "DateOfBirth": "1993-01-11T00:00:00Z",
        "Gender": {
          "InternalName": "Male",
          "Id": "b80377ee-a3e4-e311-9d0e-00155d801b09",
          "Name": "Мужской"
        },
        "IsActive": true,
        "Citizenship": {
          "Id": "8cf71b05-2138-e411-80b6-00259071bd19",
          "Name": "Россия"
        },
        "PlaceOfBirth": "г. Тюмень",
        "MaritalStatus": {
          "Id": "06c35ba2-b2ca-e311-b4d8-00155d801b09",
          "Name": "Женат/замужем"
        },
        "EmployeeNumber": null
      },
      "Relatives": null,
      "Documents": null,
      "RegistrationAddress": null,
      "HomeAddress": {
        "Id": "686adb25-db20-ea11-80c1-0025909368bb",
        "Country": {
          "Id": "8cf71b05-2138-e411-80b6-00259071bd19",
          "Name": "Россия"
        },
        "Region": null,
        "City": {
          "Id": "ce2d7405-2138-e411-80b6-00259071bd19",
          "Name": "Санкт-Петербург",
          "Country": {
            "Id": "8cf71b05-2138-e411-80b6-00259071bd19",
            "Name": "Россия"
          },
          "Region": null,
          "Area": null,
          "ParentCity": null,
          "Type": "г",
          "KladrCode": "7800000000000",
          "KladrSort": "000000000"
        },
        "Street": null,
        "House": null,
        "Apartment": null,
        "Building": null,
        "Block": null,
        "PostalCode": null,
        "RegistrationDate": null
      },
      "Contacts": [
        {
          "Id": "6d6adb25-db20-ea11-80c1-0025909368bb",
          "Type": {
            "InternalName": null,
            "Id": "3f727caa-ba18-e411-a462-00155d80001c",
            "Name": "E-mail"
          },
          "Value": "rinat.abaydulin@onetwotrip.com",
          "Note": null
        },
        {
          "Id": "6e6adb25-db20-ea11-80c1-0025909368bb",
          "Type": {
            "InternalName": "MobilePhone",
            "Id": "3d727caa-ba18-e411-a462-00155d80001c",
            "Name": "Мобильный телефон"
          },
          "Value": "+79199229848",
          "Note": null
        }
      ],
      "Education": null,
      "Skills": null,
      "CustomFieldValueSet": null
    },
    "WorkInfo": {
      "Id": "6c6adb25-db20-ea11-80c1-0025909368bb",
      "EmploymentHistory": [
        {
          "Id": "0d1d4f5a-db20-ea11-80c1-0025909368bb",
          "EmploymentAction": {
            "InternalName": "Employment",
            "Id": "5a727caa-ba18-e411-a462-00155d80001c",
            "Name": "Прием"
          },
          "Date": "2019-12-16T00:00:00Z",
          "ContractNumber": null,
          "Terms": null,
          "Department": {
            "Id": "0f22bfc3-340b-e711-80be-0025909368bb",
            "Name": "Отдел по работе с отелями. B2B Департамент"
          },
          "Position": {
            "Id": "84b01104-370d-e711-80be-0025909368bb",
            "Name": "Специалист по контрактингу отелей"
          },
          "EmploymentType": {
            "Id": "f9c25ba2-b2ca-e311-b4d8-00155d801b09",
            "Name": "Полная занятость"
          },
          "Manager": {
            "Id": "fb54056d-cfc5-e611-80be-0025909368bb",
            "FirstName": "Денис",
            "MiddleName": "Дмитриевич",
            "LastName": "Дроздовский",
            "IsActive": true,
            "Position": null,
            "Department": null,
            "WorkStatus": null,
            "PhotoId": "fc1d4534-8e10-4c42-918d-1ea6dfa40ccb",
            "User": null
          },
          "Specialization": null,
          "TestPeriod": 3,
          "DateOfSigning": null,
          "DateTo": null,
          "Notes": null,
          "TransferReason": null,
          "DismissalReason": null,
          "Branch": {
            "Id": "7e365665-b34f-e711-80be-0025909368bb",
            "Name": "Санкт-Петербург. Обводный канал"
          },
          "Projects": [],
          "Role": {
            "Id": "e9f7ca67-1d9e-e611-80be-0025909368bb",
            "Name": "Сотрудник"
          },
          "Company": {
            "Id": "1f628218-7ecc-e411-80be-00259071bd19",
            "Name": "ООО «Вайт Тревел»"
          },
          "IsOfficial": true
        }
      ],
      "Payments": null,
      "Bonuses": null,
      "CustomFieldValueSet": null
    },
    "Files": null
  }
}
*/