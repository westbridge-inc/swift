/// API endpoint constants — all routes versioned under /api/v1
class ApiEndpoints {
  ApiEndpoints._();

  static const baseUrl = 'http://localhost:3000';
  static const apiVersion = '/api/v1';

  // Auth
  static const sendOtp = '$apiVersion/auth/send-otp';
  static const verifyOtp = '$apiVersion/auth/verify-otp';
  static const register = '$apiVersion/auth/register';
  static const refreshToken = '$apiVersion/auth/refresh';
  static const logout = '$apiVersion/auth/logout';

  // Rides (Module A)
  static const rideEstimate = '$apiVersion/rides/estimate';
  static const rideRequest = '$apiVersion/rides/request';
  static String rideDetails(String id) => '$apiVersion/rides/$id';
  static String rideCancel(String id) => '$apiVersion/rides/$id/cancel';
  static const rideActive = '$apiVersion/rides/active';
  static const rideHistory = '$apiVersion/rides/history';

  // Eats (Module B)
  static const eatsHome = '$apiVersion/customer/home';
  static const eatsVendors = '$apiVersion/customer/vendors';
  static String eatsVendorDetail(String id) => '$apiVersion/customer/vendors/$id';
  static const eatsCart = '$apiVersion/customer/cart';
  static const eatsCartItems = '$apiVersion/customer/cart/items';
  static const eatsCheckout = '$apiVersion/customer/checkout';
  static const eatsSearch = '$apiVersion/search/vendors';
  static const eatsFavorites = '$apiVersion/customer/favorites';

  // Courier (Module C)
  static const courierEstimate = '$apiVersion/courier/estimate';
  static const courierOrder = '$apiVersion/courier/order';
  static String courierDetails(String id) => '$apiVersion/courier/order/$id';
  static String courierTrack(String id) => '$apiVersion/courier/order/$id/track';

  // Orders
  static const orders = '$apiVersion/customer/orders';
  static String orderDetails(String id) => '$apiVersion/customer/orders/$id';
  static String orderCancel(String id) => '$apiVersion/customer/orders/$id/cancel';
  static String orderRate(String id) => '$apiVersion/customer/orders/$id/rate';
  static String orderReorder(String id) => '$apiVersion/customer/orders/$id/reorder';

  // Wallet
  static const wallet = '$apiVersion/customer/wallet';
  static const walletTopup = '$apiVersion/customer/wallet/topup';
  static const walletWithdraw = '$apiVersion/customer/wallet/withdraw';
  static const walletTransactions = '$apiVersion/customer/wallet/transactions';

  // Profile
  static const profile = '$apiVersion/customer/profile';
  static const switchRole = '$apiVersion/customer/switch-role';
  static const addresses = '$apiVersion/customer/addresses';

  // Notifications
  static const notifications = '$apiVersion/customer/notifications';
  static const unreadCount = '$apiVersion/customer/notifications/unread-count';

  // Promo
  static const validatePromo = '$apiVersion/customer/promo/validate';

  // Rider endpoints (when in Rider role)
  static const riderProfile = '$apiVersion/rider/profile';
  static const riderGoOnline = '$apiVersion/rider/go-online';
  static const riderGoOffline = '$apiVersion/rider/go-offline';
  static const riderLocation = '$apiVersion/rider/location';
  static const riderAvailableOrders = '$apiVersion/rider/orders/available';
  static const riderActiveOrder = '$apiVersion/rider/orders/active';
  static const riderEarnings = '$apiVersion/rider/earnings';

  // Driver endpoints (when in Driver role)
  static const driverProfile = '$apiVersion/driver/profile';
  static const driverGoOnline = '$apiVersion/driver/go-online';
  static const driverGoOffline = '$apiVersion/driver/go-offline';
  static const driverLocation = '$apiVersion/driver/location';
  static const driverAvailableRides = '$apiVersion/driver/rides/available';
  static const driverActiveRide = '$apiVersion/driver/rides/active';
  static const driverEarnings = '$apiVersion/driver/earnings';
}
