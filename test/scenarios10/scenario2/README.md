# Scenario 2
Demonstrates arrays and an override that uses environment variable fallback.

- base.conf sets server.ports = [8080, 9090, 10000]
- overrides.conf sets server.ports = [${?APP_PORT}]
- .env is empty, so environment variable is not set => we keep the original array.
