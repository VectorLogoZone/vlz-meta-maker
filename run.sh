#!/bin/bash
#
# run locally
#

export $(grep ^[^\#] .env)
node server.js