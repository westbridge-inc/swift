export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: PaginationMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SendOtpRequest {
  phone: string;
}

export interface VerifyOtpRequest {
  phone: string;
  code: string;
}

export interface RegisterRequest {
  phone: string;
  firstName: string;
  lastName: string;
  email?: string;
}

export interface LoginResponse {
  user: import('./user').User;
  tokens: AuthTokens;
}

export interface SwitchRoleRequest {
  role: 'CUSTOMER' | 'VENDOR' | 'RIDER' | 'DRIVER' | 'MOVER';
}

export interface SwitchRoleResponse {
  role: import('./user').UserRole | 'VENDOR';
  activeRole: import('./user').UserRole;
  lastMoverRole: import('./user').MoverRole | null;
  message: string;
}

export interface RecoveryInitiateRequest {
  phone?: string;
  email?: string;
  fullName?: string;
}
