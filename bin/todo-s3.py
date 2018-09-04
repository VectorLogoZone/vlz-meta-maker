#!/usr/bin/env python3
#
# copy from archive into proper directories
#

import argparse
import boto3
import datetime
import os
import sys
import time
import yaml

default_input = "metadata.vectorlogo.zone"
default_output = "/home/amarcuse/site/vectorlogozone/www/logos"
default_profile = "vlz-meta-maker"

parser = argparse.ArgumentParser()
parser.add_argument("-q", "--quiet", help="hide status messages", default=True, dest='verbose', action="store_false")
parser.add_argument("--input", help="input S3 bucket (default=%s)" % default_input, action="store", default=default_input)
parser.add_argument("--output", help="output directory (default=%s)" % default_output, action="store", default=default_output)
parser.add_argument("--profile", help="aws profile (default=%s)" % default_profile, action="store", default=default_profile)
parser.add_argument("--nopurge", help="do not erase S3 files", default=True, dest='purge', action="store_false")

args = parser.parse_args()

if args.verbose:
    sys.stdout.write("INFO: update starting at %s\n" % datetime.datetime.fromtimestamp(time.time()).strftime('%Y-%m-%d %H:%M:%S'))

bucket = boto3.Session(profile_name=args.profile).resource('s3').Bucket(args.input)

addCount = 0
updateCount = 0
errCount = 0

for key in bucket.objects.all():
    filename = key.key
    if len(filename) < 5 or filename[0] == '.' or filename[0] == '_' or filename[-5:] != ".yaml":
        sys.stdout.write("INFO: skipping %s (filename not eligible)\n" % filename)
        continue

    sys.stdout.write("INFO: processing %s\n" % filename)

    content = key.get()['Body'].read().decode('utf-8')
    if args.verbose:
        sys.stdout.write("INFO: read %d chars\n" % len(content))

    data = yaml.safe_load(content)

    if "logohandle" not in data:
        sys.stdout.write("ERROR: no logo handle in %s\n" % key)
        errCount += 1
        continue

    logohandle = data["logohandle"]

    dirname = os.path.join(args.output, logohandle)

    if os.path.exists(dirname):
        if args.verbose:
            sys.stdout.write("INFO: using existing directory '%s'\n" % dirname)
    else:
        if args.verbose:
            sys.stdout.write("INFO: creating directory '%s'\n" % dirname)
        os.makedirs(dirname)

    indexname = os.path.join(dirname, "index.md")
    if os.path.exists(indexname):
        sys.stdout.write("WARNING: existing file not overwritten '%s'\n" % indexname)
        # LATER: merge
        errCount += 1
    else:
        addCount += 1
        if args.verbose:
            sys.stdout.write("INFO: creating file '%s'\n" % indexname)
        f = open(indexname, "w")
        f.write("---\n")
        f.write(content)
        f.write("---\n")
        f.close()

        if args.purge:
            key.delete()
            sys.stdout.write("INFO: deleted S3 key '%s'\n" % key.key)

sys.stdout.write("INFO: %d added, %d updated, %d errors\n" % (addCount, updateCount, errCount))
if args.verbose:
    sys.stdout.write("INFO: update complete at %s\n" % datetime.datetime.fromtimestamp(time.time()).strftime('%Y-%m-%d %H:%M:%S'))
