## Slack bots

###Bots

* Zina - bot for claiming developer's servers.
* office time - for logging developer office time

### Syntax:

#### Zina

* `botname list`
* `botname get <server>`
* `botname free <server>`

#### Office time

* `Surname` - get user time by surname

### Config
`./servers` directory contains one file per available server.
json file format:
```json
{
	"webhook_destroy_server":"http://ya.ru?destroy",
	"webhook_create_server":"http://ya.ru?create"
}
```

###Run
Run script `start.sh`:
```bash
#/bin/bash
export SLACK_API_TOKEN="...token..."
node index.js
```
