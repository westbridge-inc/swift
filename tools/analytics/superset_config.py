# Swift Analytics — Superset config, branded + themed to the Swift palette.
import os

SECRET_KEY = os.environ.get("SUPERSET_SECRET_KEY", "swift-analytics-local-dev-only")

# Branding
APP_NAME = "Swift Analytics"

# Swift theme — deep Indian-Red #803B3B on warm paper #FBFBF9 (matches the app,
# packages/ui/tokens.ts). Superset 4.1 runtime theming via Ant Design v5 tokens.
THEME_OVERRIDES = {
    "token": {
        "colorPrimary": "#803B3B",
        "colorLink": "#803B3B",
        "colorInfo": "#803B3B",
        "colorBgLayout": "#FBFBF9",
        "colorBgContainer": "#FFFFFF",
        "borderRadius": 8,
        "fontFamily": "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    },
}

FEATURE_FLAGS = {
    "DASHBOARD_RBAC": True,
    "EMBEDDED_SUPERSET": False,
}

# Local single-user analytics — keep it simple. No telemetry.
SCARF_ANALYTICS = False
WTF_CSRF_ENABLED = True
WTF_CSRF_EXEMPT_LIST = []
TALISMAN_ENABLED = False

# Let a chart query run a little longer for ad-hoc exploration.
SUPERSET_WEBSERVER_TIMEOUT = 120
SQLLAB_TIMEOUT = 120
