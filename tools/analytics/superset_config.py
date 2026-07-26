# Swift Analytics — Superset config, branded + themed to the Swift palette.
import os

SECRET_KEY = os.environ.get("SUPERSET_SECRET_KEY", "swift-analytics-local-dev-only")

# Branding
APP_NAME = "Swift Analytics"

# Swift theme — deep Indian-Red #803B3B (matches the app, packages/ui/tokens.ts).
# Superset consumes colors.primary.{base,dark*,light*}; light5 == Swift's soft
# tint #F5EBEC, dark1 == Swift's deep #5C2A2C — so buttons, links, active tabs,
# selected rows and the primary chart series all render Swift-red.
THEME_OVERRIDES = {
    "borderRadius": 8,
    "colors": {
        "primary": {
            "base": "#803B3B",
            "dark1": "#5C2A2C",
            "dark2": "#3D1C1D",
            "light1": "#9D5F5F",
            "light2": "#B98888",
            "light3": "#D4B1B1",
            "light4": "#E8D3D3",
            "light5": "#F5EBEC",
        },
        "secondary": {
            "base": "#5C2A2C",
            "dark1": "#3D1C1D",
        },
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
