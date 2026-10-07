declare const prisma: any;
declare const sqlFromRequest: string;
declare const token: string;
declare const refreshToken: string;
declare const pin: string;
declare const AsyncStorage: any;
declare const jwt: any;
declare const logger: any;
declare function sendPush(input: unknown): void;

// ruleid: swift-prisma-raw-unsafe
prisma.$queryRawUnsafe(sqlFromRequest);

function generateOtp() {
  // ruleid: swift-math-random-for-code
  return Math.random().toString().slice(2, 8);
}

// ruleid: swift-token-in-asyncstorage
AsyncStorage.setItem('refreshToken', token);

// ruleid: swift-public-env-secret
const publicSecret = process.env.NEXT_PUBLIC_PAYMENT_API_KEY;

// ruleid: swift-cors-wildcard-with-credentials
app.register(cors, { origin: '*', credentials: true });

// ruleid: swift-jwt-decode-not-verify
jwt.decode(token);

// ruleid: swift-log-sensitive-value
logger.info('login result', refreshToken);

// ruleid: swift-prisma-delete-many-no-where
prisma.session.deleteMany();

// ruleid: swift-prisma-delete-many-no-where
prisma.notification.updateMany({ data: { read: true } });

// ruleid: swift-prisma-bypass-rls-comment
const unsafeRole = 'service_role';

// ruleid: swift-code-in-push-payload
sendPush({ deliveryPin: pin });

// ok: swift-prisma-raw-unsafe
prisma.$queryRawUnsafe('SELECT 1');

// ok: swift-prisma-delete-many-no-where
prisma.session.deleteMany({ where: { userId: 'user-id' } });

// ok: swift-prisma-delete-many-no-where
prisma.notification.updateMany({ where: { userId: 'user-id' }, data: { read: true } });

// ok: swift-math-random-for-code
function jitterDelay() {
  return Math.random() * 100;
}

void publicSecret;
void generateOtp;
void jitterDelay;
