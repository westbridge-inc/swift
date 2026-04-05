import 'package:socket_io_client/socket_io_client.dart' as io;
import '../constants/api_endpoints.dart';

/// Socket.IO client for real-time order tracking, location updates, and chat.
class SocketClient {
  static final SocketClient _instance = SocketClient._internal();
  factory SocketClient() => _instance;

  io.Socket? _socket;

  SocketClient._internal();

  void connect(String accessToken) {
    _socket = io.io(
      ApiEndpoints.baseUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': accessToken})
          .enableAutoConnect()
          .enableReconnection()
          .build(),
    );

    _socket!.onConnect((_) => print('Socket connected'));
    _socket!.onDisconnect((_) => print('Socket disconnected'));
    _socket!.onError((error) => print('Socket error: $error'));
  }

  /// Subscribe to order status updates
  void onOrderUpdate(String orderId, Function(dynamic) callback) {
    _socket?.on('order:status_update:$orderId', callback);
  }

  /// Subscribe to rider/driver location broadcasts
  void onLocationUpdate(String orderId, Function(dynamic) callback) {
    _socket?.on('location:broadcast:$orderId', callback);
  }

  /// Send rider/driver location update
  void emitLocation(double lat, double lng, double heading, double speed) {
    _socket?.emit('location:update', {
      'lat': lat,
      'lng': lng,
      'heading': heading,
      'speed': speed,
      'timestamp': DateTime.now().toIso8601String(),
    });
  }

  /// Subscribe to new order alerts (for riders/drivers)
  void onNewOrderAlert(Function(dynamic) callback) {
    _socket?.on('order:new', callback);
  }

  /// Subscribe to ride match events (for customers)
  void onDriverMatch(Function(dynamic) callback) {
    _socket?.on('driver:match', callback);
  }

  void disconnect() {
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }

  bool get isConnected => _socket?.connected ?? false;
}
