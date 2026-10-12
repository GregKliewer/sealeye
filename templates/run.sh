#!/bin/bash
# The platform start script, injected into the packaged artifact. __ENTRY_POINT__ is
# replaced with the entry point from the plan when the artifact is built, so the app
# starts the way the plan says it does. The developer's own folder is never touched.
#
# The platform's settings reader runs first (.sealeye/settings.mjs, from
# templates/sealeye-settings.mjs): when SEALEYE_SETTINGS_PATH names the app's folder in
# the organization's store, it sets the app's settings as environment variables, or stops
# the app from starting if it cannot. Without that variable it does nothing.
exec node --import "$(dirname "$0")/.sealeye/settings.mjs" "__ENTRY_POINT__"
