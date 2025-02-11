# Scenario 7
Environment variable fallback in a single file:

someKey = "defaultValue"
someKey = ${?UNDEFINED_ENV}
