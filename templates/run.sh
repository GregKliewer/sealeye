#!/bin/bash
# The platform start script, injected into the packaged artifact. __ENTRY_POINT__ is
# replaced with the entry point from the plan when the artifact is built, so the app
# starts the way the plan says it does. The developer's own folder is never touched.
exec node "__ENTRY_POINT__"
