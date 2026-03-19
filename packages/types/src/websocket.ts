export enum WebSocketEvent {
  // Client → Server
  LOCATION_UPDATE = 'location:update',
  ORDER_SUBSCRIBE = 'order:subscribe',

  // Server → Client
  ORDER_STATUS_CHANGED = 'order:status_changed',
  ORDER_RIDER_LOCATION = 'order:rider_location',
  ORDER_NEW = 'order:new',
  ORDER_ASSIGNED = 'order:assigned',
  RIDE_NEW = 'ride:new',
  RIDE_DRIVER_LOCATION = 'ride:driver_location',
  NOTIFICATION_NEW = 'notification:new',
  CHAT_MESSAGE = 'chat:message',
  CHAT_TYPING = 'chat:typing',
}

export interface LocationUpdate {
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  accuracy?: number;
  timestamp: number;
}

export interface OrderLocationUpdate {
  orderId: string;
  latitude: number;
  longitude: number;
  heading?: number;
  estimatedMinutes?: number;
}
