# Scenario 3
Multiple includes and environment usage:

- base.conf includes overrides.conf
- overrides.conf includes extra.conf
- .env sets MY_FLAG => overrides app.version
