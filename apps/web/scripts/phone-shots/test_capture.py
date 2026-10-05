import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capture import classify_request, loaded_state


class CaptureGuardTests(unittest.TestCase):
    def test_staging_api_is_mocked_and_unexpected_external_request_is_blocked(self):
        self.assertEqual(classify_request('https://api-staging.swiftgy.com/api/v1/vendor/orders'), 'mock')
        self.assertEqual(classify_request('https://api.swiftgy.com/api/v1/vendor/orders'), 'mock')
        self.assertEqual(classify_request('http://127.0.0.1:3108/_next/static/app.js'), 'local')
        self.assertEqual(classify_request('https://unrelated.example/track'), 'block')

    def test_readiness_requires_exact_route_fixture_and_no_api_error(self):
        self.assertTrue(loaded_state('/portal/history', 'http://127.0.0.1:3108/portal/history',
                                     'Swift Earner History SW-1001', 'complete', []))
        self.assertFalse(loaded_state('/portal/history', 'http://127.0.0.1:3108/login',
                                      'Swift Earner History SW-1001', 'complete', []))
        self.assertFalse(loaded_state('/portal/history', 'http://127.0.0.1:3108/portal/history',
                                      'Swift Earner History Loading…', 'complete', []))
        self.assertFalse(loaded_state('/portal/history', 'http://127.0.0.1:3108/portal/history',
                                      'Swift Earner History SW-1001', 'complete', ['GET /api/v1/rider/orders: 500']))


if __name__ == '__main__':
    unittest.main()
