package main

import (
	"database/sql"
	"fmt"
	_ "github.com/nakagami/firebirdsql"
	"os"
	"sort"
	"strings"
	"time"
)

func scanUsers(conn *sql.DB, name string) (res []string) {
	// USER_ID AREA_ID USER_NAME AREA_NAME POSITION DEPT_ID DEPT PHONE MOBILE GROUP
	rows, err := conn.Query("SELECT USER_ID, USER_NAME FROM V_USERS WHERE USER_NAME LIKE '%" + name + "%'")
	if err != nil {
		fmt.Println(err)
		return
	}
	defer rows.Close()

	var userID string
	var userName string

	for rows.Next() {
		rows.Scan(&userID, &userName)
		fmt.Println(userName)
		res = append(res, userID)
	}
	return
}

func viewUser(conn *sql.DB, userID string) {
	// [SN EV_DATETIME TA_TYPE USER_ID]
	rows, _ := conn.Query("select EV_DATETIME, TA_TYPE from TALOG where USER_ID = ? order by EV_DATETIME ASC", userID)
	defer rows.Close()

	days := make(map[string]int64)
	additionalInfo := make(map[string]string)

	var dateTime time.Time
	var taType int
	for rows.Next() {
		rows.Scan(&dateTime, &taType)
		processDay(dateTime, taType, days, additionalInfo)
	}

	printDays(days, additionalInfo)
	fmt.Printf("---------------------------------------------------------------------------\r\n")
	printWeeks(days)
}

var lastKnownType string

func processDay(dateTime time.Time, taType int, days map[string]int64, additionalInfo map[string]string) {
	visitTime := dateTime.Format(time.RFC3339)[11:16]
	if taType == 1 {
		visitTime = "IN  " + visitTime
	} else {
		visitTime = "OUT " + visitTime
	}

	day := dateTime.Format(time.RFC3339)[0:10]
	typeToCmp := day + string(taType)

	if lastKnownType != typeToCmp {
		if taType == 2 {
			days[day] += dateTime.Unix()
		} else if taType == 1 {
			days[day] -= dateTime.Unix()
		} else {
			fmt.Printf("unsupported event type: %d\n", taType)
		}
	}
	// fmt.Println(day, visitTime, taType, days[day], lastKnownType, dateTime.Unix())
	lastKnownType = typeToCmp

	additionalInfo[day] = additionalInfo[day] + "(" + visitTime + ") "
}

func printDays(days map[string]int64, additionalInfo map[string]string) {
	var sortedDays []string

	for day := range days {
		sortedDays = append(sortedDays, day)
	}
	sortedDays = addAbsentDates(sortedDays)

	for _, day := range sortedDays {
		duration, _ := getDayHours(days[day])
		printTime := getHourFormat(duration)
		weekday := getTime(day).Weekday().String()[:3]
		fmt.Printf("%s  %.2d  %s  %s  %s\r\n", day, getWeek(day), weekday, printTime, additionalInfo[day])
	}
}

func printWeeks(days map[string]int64) {
	var sortedDays []string
	weeks := make(map[int]float32)
	badHoursDetected := make(map[int]int)

	for dayi := range days {
		sortedDays = append(sortedDays, dayi)
	}
	sortedDays = addAbsentDates(sortedDays)

	for _, day := range sortedDays {
		week := getWeek(day)
		dayHours, err := getDayHours(days[day])
		if err {
			badHoursDetected[week] = '*'
			weeks[week] += 0 // if every day is broken week will absent in map
		} else {
			weeks[week] += dayHours
		}
	}

	var sortedWeeks []int
	for week := range weeks {
		sortedWeeks = append(sortedWeeks, week)
	}
	sort.Ints(sortedWeeks)

	for _, week := range sortedWeeks {
		duration := weeks[week]
		printTime := getHourFormat(duration)
		fmt.Printf("week: %.2d hours: %s %c\r\n", week, printTime, badHoursDetected[week])
	}
}

func main() {
	conn, _ := sql.Open("firebirdsql", os.Getenv("DBPATH"))
	defer conn.Close()

	if len(os.Args) > 1 {
		name := strings.Join(os.Args[1:], " ")
		users := scanUsers(conn, name)
		if len(users) == 1 {
			viewUser(conn, users[0])
		}
	}
}

func getHourFormat(duration float32) string {
	if duration == 0 {
		return "--:--"
	}
	hours := int(duration)
	minutes := int(60 * (duration - float32(hours)))
	return fmt.Sprintf("%.2d:%.2d", hours, minutes)
}

func getDayHours(seconds int64) (float32, bool) {
	duration := float32(seconds) / 3600
	if duration < 0.05 {
		return 0.0, true
	} else if duration > 24 {
		return 0.0, true
	}
	return duration, false
}

func getWeek(day string) int {
	_, week := getTime(day).ISOWeek()
	return week
}

func getTime(date string) time.Time {
	t, _ := time.Parse(time.RFC3339, date+"T00:00:00Z")
	return t
}

func getDay(time time.Time) string {
	return time.String()[:10]
}

func addAbsentDates(sortedDays []string) []string {
	if len(sortedDays) < 1 {
		return sortedDays
	}

	sort.Strings(sortedDays)
	min := getTime(sortedDays[0])
	max := time.Now()

	var newSortedDays []string
	for ; !min.After(max); min = min.Add(time.Hour * 24) {
		newSortedDays = append(newSortedDays, getDay(min))
	}
	return newSortedDays
}

func addAbsentWeeks(sortedWeeks []int) []int {
	if len(sortedWeeks) < 1 {
		return sortedWeeks
	}

	sort.Ints(sortedWeeks)
	min := sortedWeeks[0]
	max := sortedWeeks[len(sortedWeeks)-1]

	var newSortedWeeks []int
	// fmt.Println("max", max, "min", min)
	for ; min <= max; min++ {
		if contains(sortedWeeks, min) || (max-min) < 20 {
			newSortedWeeks = append(newSortedWeeks, min)
		}
	}
	return newSortedWeeks
}

func contains(s []int, e int) bool {
	for _, a := range s {
		if a == e {
			return true
		}
	}
	return false
}
