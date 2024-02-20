const fs = require('fs');

const daysNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
let data = fs.readFileSync('/Users/konstantin/Downloads/_SELECT_EV_DATETIME_TA_TYPE_ta_USER_ID_u_DEPT_u_USER_NAME_from_T_202402201221.csv')
.toString().split('\n').slice(1)

const SQL_QUERY = `SELECT EV_DATETIME, TA_TYPE, ta.USER_ID,  u.DEPT, u.USER_NAME  from TALOG ta
LEFT JOIN V_USERS u ON ta.USER_ID = u.USER_ID
WHERE EV_DATETIME > '2023-11-01 04:00:00'
ORDER BY EV_DATETIME ASC`

// "EV_DATETIME","TA_TYPE","USER_ID","USER_NAME"
const startDate = new Date('2024-01-01');
const totalDays = Math.ceil((Date.now() - startDate.valueOf())/(24*60*60*1000));

console.log('totalDays', totalDays)
// return

const employees  = {}
for (let row of data) {
	let [date,,,dep, empName] = row.split(',');
	date = new Date(date.slice(0,10));
	if (date < startDate) { continue; }

	if (!employees[empName]) {
		employees[empName] = {
			dep,
			visits: [0,0,0,0,0,0,0],
			lastDate: 0,
		}
	}

	if (employees[empName].lastDate < date) {
		const day = date.getDay();
		employees[empName].visits[day]++;
		employees[empName].lastDate = date;
	}
}

console.log('Департамент, Сотрудник,', daysNames.join(','));
for (let empName in employees) {
	const counts = employees[empName].visits
	const dep = employees[empName].dep
	counts.push(counts.shift());
	console.log(`${dep},${empName},${counts.join(',')}`);
}


