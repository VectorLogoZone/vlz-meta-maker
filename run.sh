#!/bin/bash
#
# run locally
#

export $(grep ^[^\#] .env)
npx nodemon server.js
