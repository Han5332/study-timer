# Notion Basic Timer

Minimal Start/Stop timer that writes to a Notion database (no CORS, same-origin only).

## Notion database fields (exact names)
- **Name** (Title)
- **Start Time** (Date with time)
- **End Time** (Date with time)
- **Subject** (Rich text, optional)
- **Duration (hours)** (Formula):
```
round(dateBetween(prop("End Time"), prop("Start Time"), "minutes") / 60 * 100) / 100
```

## Run
```bash
npm install
npm start
# open http://localhost:8787
```
