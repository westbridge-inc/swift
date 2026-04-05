# Swift Super App - System Design Document

> **Uber-grade multi-vertical super app** — Rides, Eats, Courier in a single unified interface.
> Built on the Swift platform's proven monetization model.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Microservices Breakdown](#3-microservices-breakdown)
4. [Data Architecture](#4-data-architecture)
5. [API Gateway & Communication](#5-api-gateway--communication)
6. [Real-Time System](#6-real-time-system)
7. [Module A: Rides](#7-module-a-rides)
8. [Module B: Eats](#8-module-b-eats)
9. [Module C: Courier](#9-module-c-courier)
10. [Authentication & Authorization](#10-authentication--authorization)
11. [Payment & Monetization](#11-payment--monetization)
12. [Maps & Location](#12-maps--location)
13. [Push Notifications](#13-push-notifications)
14. [Search & Discovery](#14-search--discovery)
15. [Background Jobs & Queues](#15-background-jobs--queues)
16. [Deployment Architecture](#16-deployment-architecture)
17. [Monorepo Folder Structure](#17-monorepo-folder-structure)
18. [UI/UX: Home Screen & Navigation](#18-uiux-home-screen--navigation)

---

## 1. Executive Summary

Swift is a **multi-vertical super app** targeting the Guyana market, combining three core verticals into a single mobile experience:

| Vertical | Uber Equivalent | Description |
|----------|----------------|-------------|
| **Rides** | Uber Rides | On-demand taxi with driver matching, surge pricing, PIN verification |
| **Eats** | Uber Eats | Food & grocery delivery with restaurant menus, cart, order tracking |
| **Courier** | Uber Connect | Parcel pickup/drop-off, instant & scheduled delivery |

### Monetization Model (Proven)

| Revenue Stream | Mechanism | Who Pays |
|---------------|-----------|----------|
| **Invisible Markup** | 5% on all item prices | Customers (hidden from vendors) |
| **Weekly Subscriptions** | Riders: $10K GYD, Drivers/Vendors: $20K GYD | Service providers |
| **Promo Code Sponsorship** | Vendors fund promotional discounts | Vendors |
| **Platform does NOT take** | Delivery fees (100% to riders), Taxi fares (100% to drivers) | — |

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Mobile (Primary)** | Flutter 3.x (Dart) — single codebase for iOS + Android |
| **Mobile (Legacy)** | React Native 0.77 — existing app, maintained in parallel |
| **API Gateway** | Node.js (Fastify 5) — routing, auth, rate limiting |
| **Microservices** | Node.js (Fastify) + Go (high-throughput services) |
| **Database** | PostgreSQL 16 + PostGIS (geospatial) |
| **Cache / Pub-Sub** | Redis 7 (caching, sessions, pub/sub, geospatial indexes) |
| **Message Queue** | BullMQ (job processing) + Redis Streams (event bus) |
| **Search** | Meilisearch 1.11 (full-text, typo-tolerant) |
| **Real-Time** | Socket.IO 4.8 (WebSocket with fallback) |
| **Maps** | Google Maps Platform (Directions, Geocoding, Places) |
| **Payments** | PowerTranz (Caribbean gateway) + Cash |
| **Push Notifications** | Firebase Cloud Messaging (FCM) |
| **File Storage** | AWS S3 / Cloudflare R2 |
| **CI/CD** | GitHub Actions |
| **Infra** | Docker + Fly.io / AWS ECS |

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                   │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │   Flutter App    │  │ React Native App │  │   Next.js Admin Panel   │  │
│  │   (iOS + Android)│  │   (iOS + Android)│  │     (Web Dashboard)     │  │
│  │                  │  │                  │  │                          │  │
│  │  ┌────┬────┬───┐ │  │  ┌────┬────┬───┐ │  │  Users │ Orders │ Finance│  │
│  │  │Ride│Eats│Pkg │ │  │  │Ride│Eats│Pkg │ │  │  Vendors │ Analytics  │  │
│  │  └────┴────┴───┘ │  │  └────┴────┴───┘ │  │  Zones │ Promos       │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────────┬───────────┘  │
│           │                     │                          │               │
└───────────┼─────────────────────┼──────────────────────────┼───────────────┘
            │ HTTPS + WSS         │ HTTPS + WSS              │ HTTPS
            ▼                     ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API GATEWAY LAYER                                 │
│                         (Fastify 5 + Node.js)                               │
│                                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  ┌────────────────────┐ │
│  │   Auth &    │  │    Rate      │  │  Request  │  │   Load Balancer   │ │
│  │  JWT Verify │  │  Limiting    │  │  Routing  │  │   & Health Check  │ │
│  └─────────────┘  └──────────────┘  └───────────┘  └────────────────────┘ │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MICROSERVICES LAYER                                 │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Auth        │  │  User        │  │  Rides       │  │  Eats        │  │
│  │  Service     │  │  Service     │  │  Service     │  │  Service     │  │
│  │  (Node.js)   │  │  (Node.js)   │  │  (Node/Go)   │  │  (Node.js)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Courier     │  │  Payment     │  │  Location    │  │  Notification│  │
│  │  Service     │  │  Service     │  │  Service     │  │  Service     │  │
│  │  (Node.js)   │  │  (Node.js)   │  │  (Go)        │  │  (Node.js)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Search      │  │  Chat        │  │  Analytics   │  │  Admin       │  │
│  │  Service     │  │  Service     │  │  Service     │  │  Service     │  │
│  │  (Node.js)   │  │  (Node.js)   │  │  (Go)        │  │  (Node.js)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                        │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  PostgreSQL  │  │   Redis 7    │  │ Meilisearch  │  │   AWS S3     │  │
│  │  16 + PostGIS│  │   Cluster    │  │   1.11       │  │   / R2       │  │
│  │              │  │              │  │              │  │              │  │
│  │  - Users     │  │  - Sessions  │  │  - Vendors   │  │  - Avatars   │  │
│  │  - Orders    │  │  - OTP       │  │  - Items     │  │  - Menus     │  │
│  │  - Vendors   │  │  - Cache     │  │  - Addresses │  │  - Documents │  │
│  │  - Payments  │  │  - Geo Index │  │              │  │  - Receipts  │  │
│  │  - Zones     │  │  - Pub/Sub   │  │              │  │              │  │
│  │  - Audit     │  │  - Job Queue │  │              │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Communication Patterns

```
┌──────────────────────────────────────────────────────────────────┐
│                   INTER-SERVICE COMMUNICATION                     │
│                                                                   │
│   Synchronous (Request/Response)          Asynchronous (Events)   │
│   ─────────────────────────────          ──────────────────────   │
│                                                                   │
│   ┌─────────┐  HTTP/gRPC  ┌─────────┐   ┌─────────┐             │
│   │Service A├────────────►│Service B│   │Service A│             │
│   └─────────┘             └─────────┘   └────┬────┘             │
│                                               │ publish          │
│   Used for:                                   ▼                  │
│   - Auth verification              ┌──────────────────┐          │
│   - Payment processing             │   Redis Streams   │          │
│   - Price calculation               │   (Event Bus)     │          │
│                                     └──┬────┬────┬────┘          │
│                                        │    │    │               │
│                                        ▼    ▼    ▼               │
│                                     ┌───┐┌───┐┌───┐             │
│                                     │ B ││ C ││ D │ subscribe   │
│                                     └───┘└───┘└───┘             │
│                                                                   │
│   Used for:                                                       │
│   - Order status updates                                          │
│   - Location broadcasts                                           │
│   - Notification triggers                                         │
│   - Analytics events                                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Microservices Breakdown

### Service Registry

| # | Service | Language | Port | Responsibility |
|---|---------|----------|------|---------------|
| 1 | **api-gateway** | Node.js | 3000 | Request routing, auth, rate limiting, API versioning |
| 2 | **auth-service** | Node.js | 3001 | OTP, JWT, sessions, registration, role switching |
| 3 | **user-service** | Node.js | 3002 | Profiles, addresses, favorites, wallet, multi-role |
| 4 | **rides-service** | Node.js/Go | 3003 | Ride requests, driver matching, fare calc, surge pricing |
| 5 | **eats-service** | Node.js | 3004 | Vendors, menus, cart, checkout, food order lifecycle |
| 6 | **courier-service** | Node.js | 3005 | Parcel orders, size/weight pricing, instant delivery |
| 7 | **location-service** | Go | 3006 | GPS tracking, geofencing, ETA calculation, proximity |
| 8 | **payment-service** | Node.js | 3007 | Payment processing, wallet, settlements, subscriptions |
| 9 | **notification-service** | Node.js | 3008 | FCM push, in-app, email, SMS dispatch |
| 10 | **search-service** | Node.js | 3009 | Meilisearch indexing, full-text vendor/item search |
| 11 | **chat-service** | Node.js | 3010 | Real-time messaging per order |
| 12 | **analytics-service** | Go | 3011 | KPIs, revenue reports, user metrics, vendor analytics |
| 13 | **admin-service** | Node.js | 3012 | Admin CRUD, audit logs, platform config |

### Service Dependency Graph

```
                            ┌──────────────┐
                            │  API Gateway │
                            └──────┬───────┘
                                   │
                    ┌──────────────┼──────────────────────┐
                    │              │                       │
               ┌────▼────┐   ┌────▼─────┐          ┌─────▼──────┐
               │  Auth   │   │  User    │          │   Admin    │
               │ Service │   │ Service  │          │  Service   │
               └────┬────┘   └────┬─────┘          └─────┬──────┘
                    │              │                       │
         ┌─────────┼──────────────┼───────────────────────┤
         │         │              │                       │
    ┌────▼────┐ ┌──▼───────┐ ┌───▼──────┐         ┌─────▼──────┐
    │  Rides  │ │  Eats    │ │ Courier  │         │ Analytics  │
    │ Service │ │ Service  │ │ Service  │         │  Service   │
    └────┬────┘ └────┬─────┘ └────┬─────┘         └────────────┘
         │           │            │
         ├───────────┼────────────┤
         │           │            │
    ┌────▼───────────▼────────────▼────┐
    │         Shared Services          │
    │                                  │
    │  ┌──────────┐  ┌──────────────┐  │
    │  │ Location │  │  Payment     │  │
    │  │ Service  │  │  Service     │  │
    │  └──────────┘  └──────────────┘  │
    │                                  │
    │  ┌──────────┐  ┌──────────────┐  │
    │  │ Notif.   │  │  Search      │  │
    │  │ Service  │  │  Service     │  │
    │  └──────────┘  └──────────────┘  │
    │                                  │
    │  ┌──────────┐                    │
    │  │  Chat    │                    │
    │  │ Service  │                    │
    │  └──────────┘                    │
    └──────────────────────────────────┘
```

### Practical Note: Modular Monolith Strategy

> **Current State (Phase 1):** Swift runs as a **modular monolith** — a single Fastify server with domain-separated modules (`/modules/auth`, `/modules/rider`, etc.). This is the right architecture for a startup.
>
> **Evolution (Phase 2):** When traffic justifies it, extract high-throughput services (Location, Analytics) into standalone Go microservices. The modular boundaries already exist in the codebase — extraction is mechanical, not architectural.
>
> **Do NOT prematurely split** into 13 separate deployments. The modular monolith gives you microservice-clean boundaries with monolith-simple operations.

---

## 4. Data Architecture

### Database Schema (Entity Relationship)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CORE DOMAIN MODELS                               │
│                                                                         │
│  ┌──────────┐    1:N    ┌──────────┐    1:N    ┌──────────────┐        │
│  │   User   ├──────────►│  Session  │          │  DeviceToken │        │
│  │          ├──────────►│          │          │              │        │
│  │ id       │    1:N    └──────────┘          └──────────────┘        │
│  │ phone    ├──────────────────────────────────────────┐               │
│  │ roles[]  │    1:N    ┌──────────┐    1:N           │               │
│  │ activeRole├─────────►│ Address  │                   │               │
│  │ walletBal│          └──────────┘                   │               │
│  └──┬──┬──┬─┘                                          │               │
│     │  │  │                                            │               │
│     │  │  └────── 1:1 ──► ┌──────────┐                │               │
│     │  │                  │ Customer │                │               │
│     │  │                  │ favVendor│                │               │
│     │  │                  └──────────┘                │               │
│     │  │                                              │               │
│     │  └───────── 1:1 ──► ┌──────────┐    1:N    ┌───▼────────┐      │
│     │                     │  Rider   ├──────────►│  Earning   │      │
│     │                     │ vehicle  │           └────────────┘      │
│     │                     │ online   │                               │
│     │                     └──────────┘                               │
│     │                                                                │
│     └──────────── 1:1 ──► ┌──────────┐    1:N    ┌────────────┐      │
│                           │  Driver  ├──────────►│  Earning   │      │
│                           │ vehicle  │           └────────────┘      │
│                           └──────────┘                               │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        VENDOR & MENU MODELS                             │
│                                                                         │
│  ┌──────────────┐   1:N   ┌──────────┐   1:N   ┌──────────────┐       │
│  │ VendorOwner ├────────►│  Vendor  ├────────►│  Category    │       │
│  └──────────────┘         │          │         └──────┬───────┘       │
│                           │ type     │                │ 1:N           │
│                           │ rating   │         ┌──────▼───────┐       │
│                           │ isOpen   │         │    Item      │       │
│                           └────┬─────┘         │ basePrice    │       │
│                                │               │ markupPrice  │       │
│                           1:N  │               └──────┬───────┘       │
│                      ┌─────────┘                      │ 1:N           │
│                      ▼                         ┌──────▼───────┐       │
│               ┌──────────────┐                 │ OptionGroup  │       │
│               │OperatingHours│                 └──────┬───────┘       │
│               └──────────────┘                        │ 1:N           │
│                                                ┌──────▼───────┐       │
│                                                │   Option     │       │
│                                                │ addlPrice    │       │
│                                                └──────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     UNIVERSAL ORDER MODEL                               │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐          │
│  │                        Order                              │          │
│  │                                                           │          │
│  │  type: FOOD_DELIVERY | GROCERY | COURIER | TAXI           │          │
│  │  status: PENDING → ACCEPTED → PREPARING → READY →        │          │
│  │          PICKED_UP → EN_ROUTE → DELIVERED → COMPLETED     │          │
│  │                                                           │          │
│  │  Pricing:                                                 │          │
│  │  ┌─────────────────┬─────────────────────────────────┐    │          │
│  │  │ subtotalBase    │ Sum of vendor base prices       │    │          │
│  │  │ subtotalMarkup  │ 5% invisible markup             │    │          │
│  │  │ subtotalCustomer│ Base + Markup (what user sees)  │    │          │
│  │  │ deliveryFee     │ Distance-based (100% to rider)  │    │          │
│  │  │ serviceFee      │ Platform fee                    │    │          │
│  │  │ tax             │ Per jurisdiction                │    │          │
│  │  │ tip             │ Optional (100% to rider)        │    │          │
│  │  │ discount        │ Promo code applied              │    │          │
│  │  │ totalAmount     │ Final charge to customer        │    │          │
│  │  └─────────────────┴─────────────────────────────────┘    │          │
│  └───────┬────────────────┬──────────────────┬───────────────┘          │
│          │ 1:N            │ 1:N              │ 1:N                      │
│   ┌──────▼──────┐  ┌──────▼───────┐  ┌──────▼──────────┐              │
│   │ OrderItem   │  │OrderStatusLog│  │    Rating       │              │
│   │ qty, price  │  │ status, time │  │ score, comment  │              │
│   └──────┬──────┘  └──────────────┘  └─────────────────┘              │
│          │ 1:N                                                         │
│   ┌──────▼──────────┐                                                  │
│   │OrderItemOption   │                                                  │
│   │ selected options │                                                  │
│   └─────────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                      FINANCIAL MODELS                                   │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ Transaction  │  │ Subscription │  │  Settlement  │                  │
│  │              │  │              │  │              │                  │
│  │ TOPUP        │  │ type         │  │ vendorId     │                  │
│  │ WITHDRAWAL   │  │ ACTIVE       │  │ period       │                  │
│  │ PAYMENT      │  │ PAUSED       │  │ grossAmount  │                  │
│  │ REFUND       │  │ PAST_DUE     │  │ markupCut    │                  │
│  │ EARNING      │  │ CANCELLED    │  │ netAmount    │                  │
│  │ PAYOUT       │  │ TRIAL        │  │ PENDING      │                  │
│  └──────────────┘  └──────────────┘  │ PROCESSED    │                  │
│                                      └──────────────┘                  │
│  ┌──────────────┐  ┌──────────────┐                                    │
│  │   Earning    │  │ PayoutRequest│                                    │
│  │              │  │              │                                    │
│  │ DELIVERY_FEE │  │ WALLET       │                                    │
│  │ COURIER_FEE  │  │ MOBILE_MONEY │                                    │
│  │ TAXI_FARE    │  │ BANK_TRANSFER│                                    │
│  │ TIP          │  │ CASH_PICKUP  │                                    │
│  │              │  │              │                                    │
│  │ PENDING →    │  │ PENDING →    │                                    │
│  │ AVAILABLE →  │  │ APPROVED →   │                                    │
│  │ PAID_OUT     │  │ COMPLETED    │                                    │
│  └──────────────┘  └──────────────┘                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Redis Data Structures

```
┌──────────────────────────────────────────────────────────────┐
│                    REDIS KEY SCHEMA                           │
│                                                              │
│  Sessions & Auth                                             │
│  ──────────────                                              │
│  otp:{phone}              → "123456"        TTL: 5min        │
│  otp:rate:{phone}         → count           TTL: 1hr         │
│  session:{userId}:{token} → sessionJSON     TTL: 30d         │
│                                                              │
│  Location (GeoSpatial)                                       │
│  ────────────────────                                        │
│  geo:riders:online        → GEOADD lat lng riderId           │
│  geo:drivers:online       → GEOADD lat lng driverId          │
│  location:{userId}        → {lat, lng, heading, speed, ts}   │
│                                                              │
│  Cache                                                       │
│  ─────                                                       │
│  cache:vendor:{id}        → vendorJSON      TTL: 5min        │
│  cache:menu:{vendorId}    → menuJSON        TTL: 5min        │
│  cache:home:{lat}:{lng}   → homeFeedJSON    TTL: 2min        │
│  cache:surge:{zoneId}     → multiplier      TTL: 1min        │
│                                                              │
│  Real-Time State                                             │
│  ──────────────                                              │
│  rider:status:{id}        → ONLINE|OFFLINE|BUSY              │
│  driver:status:{id}       → ONLINE|OFFLINE|ON_RIDE           │
│  order:tracking:{id}      → {status, riderLoc, eta}          │
│                                                              │
│  Pub/Sub Channels                                            │
│  ────────────────                                            │
│  channel:order:{orderId}  → status updates, location         │
│  channel:rider:{riderId}  → new order alerts                 │
│  channel:driver:{driverId}→ new ride alerts                  │
│  channel:vendor:{vendorId}→ incoming orders                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. API Gateway & Communication

### Request Flow

```
  Mobile App                    API Gateway                    Service
  ──────────                    ───────────                    ───────
      │                              │                            │
      │  POST /api/v1/eats/checkout  │                            │
      │─────────────────────────────►│                            │
      │                              │                            │
      │                   ┌──────────┤                            │
      │                   │ 1. Verify│JWT                         │
      │                   │ 2. Rate  │Limit Check                 │
      │                   │ 3. Parse │& Validate                  │
      │                   └──────────┤                            │
      │                              │                            │
      │                              │  Forward to Eats Service   │
      │                              │───────────────────────────►│
      │                              │                            │
      │                              │                  ┌─────────┤
      │                              │                  │ Validate│Cart
      │                              │                  │ Calc    │Markup
      │                              │                  │ Check   │Promo
      │                              │                  │ Create  │Order
      │                              │                  │ Debit   │Wallet
      │                              │                  └─────────┤
      │                              │                            │
      │                              │  ┌─ Publish Events ───────►│
      │                              │  │  order.created           │
      │                              │  │  payment.charged         │
      │                              │  │  notification.send       │
      │                              │                            │
      │                              │◄───────────────────────────│
      │◄─────────────────────────────│    Response: Order JSON     │
      │                              │                            │
```

### API Versioning

```
/api/v1/auth/*          → Auth Service
/api/v1/user/*          → User Service
/api/v1/rides/*         → Rides Service
/api/v1/eats/*          → Eats Service (customer-facing)
/api/v1/courier/*       → Courier Service
/api/v1/vendor/*        → Eats Service (vendor-facing)
/api/v1/rider/*         → shared rider endpoints
/api/v1/driver/*        → Rides Service (driver-facing)
/api/v1/search/*        → Search Service
/api/v1/chat/*          → Chat Service
/api/v1/admin/*         → Admin Service
/api/v1/location/*      → Location Service
```

---

## 6. Real-Time System

### WebSocket Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                    SOCKET.IO ARCHITECTURE                          │
│                                                                    │
│  ┌─────────┐                    ┌──────────────────┐              │
│  │ Flutter │◄──── WSS ────────►│  Socket.IO       │              │
│  │  App    │                    │  Server          │              │
│  └─────────┘                    │                  │              │
│                                 │  Namespaces:     │              │
│  ┌─────────┐                    │  /orders    ─────┼─► Order      │
│  │  React  │◄──── WSS ────────►│  /tracking  ─────┼─► Location   │
│  │ Native  │                    │  /chat      ─────┼─► Messages   │
│  └─────────┘                    │  /rider     ─────┼─► Rider Hub  │
│                                 │  /driver    ─────┼─► Driver Hub │
│  ┌─────────┐                    │  /vendor    ─────┼─► Vendor Hub │
│  │  Admin  │◄──── WSS ────────►│  /admin     ─────┼─► Admin Feed │
│  │  Panel  │                    │                  │              │
│  └─────────┘                    └────────┬─────────┘              │
│                                          │                        │
│                                   ┌──────▼──────┐                │
│                                   │ Redis Pub/Sub│                │
│                                   │ (Scaling)    │                │
│                                   └─────────────┘                │
└────────────────────────────────────────────────────────────────────┘
```

### Event Catalog

| Event | Direction | Payload | Used By |
|-------|-----------|---------|---------|
| `order:status_update` | Server → Client | `{orderId, status, eta}` | Customer, Vendor |
| `order:new` | Server → Rider/Driver | `{order, vendor, pickup}` | Available Orders |
| `location:update` | Client → Server | `{lat, lng, heading, speed}` | Rider/Driver GPS |
| `location:broadcast` | Server → Client | `{riderId, lat, lng, eta}` | Order Tracking Map |
| `chat:message` | Bidirectional | `{roomId, text, sender}` | In-Order Chat |
| `surge:update` | Server → Client | `{zoneId, multiplier}` | Fare Display |
| `driver:match` | Server → Customer | `{driver, vehicle, eta}` | Ride Matching |

---

## 7. Module A: Rides

### Ride Lifecycle

```
┌────────────────────────────────────────────────────────────────────────┐
│                       RIDE LIFECYCLE                                    │
│                                                                        │
│  CUSTOMER                    SYSTEM                     DRIVER          │
│  ────────                    ──────                     ──────          │
│                                                                        │
│  ┌─────────────────┐                                                   │
│  │ 1. Request Ride  │                                                   │
│  │    - Pickup loc  │                                                   │
│  │    - Dropoff loc │                                                   │
│  │    - Car type    │                                                   │
│  └────────┬────────┘                                                   │
│           │                                                            │
│           ▼                                                            │
│  ┌─────────────────┐                                                   │
│  │ 2. Fare Estimate │                                                   │
│  │    base + dist   │                                                   │
│  │    + time + surge│                                                   │
│  └────────┬────────┘                                                   │
│           │ confirm                                                     │
│           ▼                                                            │
│                         ┌─────────────────┐                            │
│                         │ 3. Driver Match  │                            │
│                         │    - Find nearest│───────────►  Accept?       │
│                         │    - Score rank  │                  │         │
│                         │    - 30s timeout │◄────────────  Yes │        │
│                         └────────┬────────┘                            │
│                                  │                                     │
│  ◄───── ETA + Driver Info ───────┤                                     │
│                                  │              ┌──────────────────┐   │
│                                  │              │ 4. En Route      │   │
│  ◄───── Live Map Tracking ───────┼──────────────│    to Pickup     │   │
│                                  │              └────────┬─────────┘   │
│                                  │                       │             │
│                                  │              ┌────────▼─────────┐   │
│                                  │              │ 5. Arrived       │   │
│  ◄───── "Driver Arrived" ────────┤              │    at Pickup     │   │
│                                  │              └────────┬─────────┘   │
│                                  │                       │             │
│  ── Share PIN: 4827 ─────────────┼──────────────────────►│             │
│                                  │              ┌────────▼─────────┐   │
│                                  │              │ 6. Verify PIN    │   │
│                                  │              │    → Start Ride  │   │
│                                  │              └────────┬─────────┘   │
│                                  │                       │             │
│  ◄───── Live Trip Tracking ──────┼──────────────────────►│             │
│                                  │              ┌────────▼─────────┐   │
│                                  │              │ 7. Complete Ride │   │
│                                  │              │    Final fare    │   │
│                                  │              │    Auto-pay      │   │
│  ◄───── Receipt + Rate ─────────┤              └──────────────────┘   │
│                                  │                                     │
└────────────────────────────────────────────────────────────────────────┘
```

### Car Types & Pricing

| Type | Base (GYD) | Per KM | Per Min | Min Fare | Multiplier |
|------|-----------|--------|---------|----------|------------|
| **SwiftX** (Economy) | 800 | 250 | 40 | 1,200 | 1.0x |
| **SwiftComfort** | 1,200 | 350 | 60 | 2,000 | 1.4x |
| **SwiftXL** (6-seat) | 1,500 | 400 | 70 | 2,500 | 1.6x |
| **SwiftPremium** | 2,000 | 500 | 80 | 3,500 | 2.0x |

### Surge Pricing Algorithm

```
surge_multiplier = f(demand, supply, zone, time)

Where:
  demand    = ride_requests_last_5min in zone
  supply    = online_drivers in zone
  ratio     = demand / supply

  if ratio < 1.5  → multiplier = 1.0  (no surge)
  if ratio < 2.0  → multiplier = 1.3
  if ratio < 3.0  → multiplier = 1.6
  if ratio < 5.0  → multiplier = 2.0
  if ratio >= 5.0 → multiplier = 2.5  (cap)

  Final fare = (base + dist*perKm + time*perMin) * carMultiplier * surgeMultiplier
```

### Driver Matching Algorithm

```
score(driver) = w1 * proximity_score
              + w2 * rating_score
              + w3 * acceptance_rate
              + w4 * completion_rate

Where:
  w1 = 0.5  (distance is most important)
  w2 = 0.2  (quality matters)
  w3 = 0.15 (reliability)
  w4 = 0.15 (completion)

  proximity_score  = 1 - (distance_km / max_radius_km)
  rating_score     = driver_rating / 5.0
  acceptance_rate  = accepted / offered (last 50 rides)
  completion_rate  = completed / accepted (last 50 rides)

Process:
  1. GEORADIUS query: find drivers within 5km
  2. Score each driver
  3. Send request to top-scored driver
  4. 30-second timeout per driver
  5. If declined/timeout → next driver (max 6 attempts)
  6. If all fail → notify customer, auto-cancel
```

---

## 8. Module B: Eats

### Order Lifecycle

```
┌────────────────────────────────────────────────────────────────────────┐
│                    EATS ORDER LIFECYCLE                                 │
│                                                                        │
│  CUSTOMER          VENDOR           SYSTEM           RIDER             │
│  ────────          ──────           ──────           ─────             │
│                                                                        │
│  Browse Menu                                                           │
│  Add to Cart                                                           │
│  Apply Promo                                                           │
│  Checkout ──────►                                                      │
│                    ◄── New Order                                        │
│                    ┌──────────┐                                         │
│  "Preparing" ◄─────│  Accept  │                                         │
│                    └────┬─────┘                                         │
│                         │                                               │
│                    ┌────▼─────┐                                         │
│                    │ Prepare  │                                         │
│                    │ Food     │      ┌────────────┐                     │
│                    └────┬─────┘      │ Auto-Assign│                     │
│                         │            │ Nearest    │────►  Accept?       │
│                    ┌────▼─────┐      │ Rider      │          │          │
│                    │  Ready   │──────┤ (BullMQ)   │◄──── Yes │          │
│                    └──────────┘      └────────────┘                     │
│                                                                        │
│                                            ┌───────────────────┐       │
│  ◄── Live Map ─────────────────────────────│ En Route Pickup   │       │
│                                            └────────┬──────────┘       │
│                                            ┌────────▼──────────┐       │
│                                            │ Arrived at Vendor │       │
│                                            └────────┬──────────┘       │
│                                            ┌────────▼──────────┐       │
│                                            │ Picked Up         │       │
│  ◄── Live Map ─────────────────────────────│ En Route Delivery │       │
│                                            └────────┬──────────┘       │
│                                            ┌────────▼──────────┐       │
│  ◄── "Food's Here!" ──────────────────────│ Delivered          │       │
│                                            └────────┬──────────┘       │
│  Rate Vendor                                        │                  │
│  Rate Rider                               Earnings credited            │
│  Tip Rider                                                             │
└────────────────────────────────────────────────────────────────────────┘
```

### Pricing Breakdown (Customer View vs Reality)

```
  What Customer Sees              What Actually Happens
  ────────────────                ──────────────────────

  Chicken Roti:  $1,050          Base Price:    $1,000  (vendor gets this)
  2x Doubles:    $630            5% Markup:     $50     (platform keeps)
  ─────────                      ─────────
  Subtotal:      $1,680          Subtotal:      $1,600  (vendor total)
                                 Markup:        $80     (platform total)
  Delivery Fee:  $700
  Service Fee:   $0              Delivery Fee:  $700    (100% to rider)
  Tax:           $0
  Tip:           $200            Tip:           $200    (100% to rider)
  Promo (-10%):  -$168
  ─────────                      ─────────
  TOTAL:         $2,412          Platform Rev:  $80     (markup only)
                                 Vendor Gets:   $1,432  (subtotal - discount)
                                 Rider Gets:    $900    (fee + tip)
```

### Menu Structure

```
Vendor
  └── Category (e.g., "Main Course", "Drinks")
        └── Item (e.g., "Chicken Roti")
              ├── basePrice: 1000 GYD
              ├── markupPrice: 1050 GYD (auto-calculated, shown to customer)
              ├── image: S3 URL
              ├── dietaryTags: ["halal"]
              ├── allergens: ["gluten"]
              ├── available: true
              └── OptionGroup (e.g., "Size", "Add-ons")
                    ├── minSelect: 1, maxSelect: 1 (for Size)
                    └── Option (e.g., "Large +$200")
                          └── additionalPrice: 200 GYD
```

---

## 9. Module C: Courier

### Courier Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                     COURIER FLOW                                       │
│                                                                        │
│  SENDER                        SYSTEM                   RIDER          │
│  ──────                        ──────                   ─────          │
│                                                                        │
│  ┌──────────────────┐                                                  │
│  │ Create Parcel    │                                                  │
│  │  - Pickup addr   │                                                  │
│  │  - Dropoff addr  │                                                  │
│  │  - Package size  │                                                  │
│  │  - Weight        │                                                  │
│  │  - Description   │                                                  │
│  │  - Photo         │                                                  │
│  │  - Speed         │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                            │
│           ▼                                                            │
│  ┌──────────────────┐                                                  │
│  │ Price Quote      │                                                  │
│  │ base + dist*rate │                                                  │
│  │ + size_surcharge │                                                  │
│  │ × speed_multi    │                                                  │
│  └────────┬─────────┘                                                  │
│           │ confirm                                                     │
│           ▼                                                            │
│                          ┌─────────────────┐                           │
│                          │ Match Rider     │                           │
│                          │ (same algo as   │──────────►  Accept?       │
│                          │  food delivery) │                 │          │
│                          └────────┬────────┘◄──────────  Yes │         │
│                                   │                                    │
│  ◄── Rider Assigned + ETA ────────┤          ┌────────────────────┐    │
│                                   │          │ En Route to Pickup │    │
│  ◄── Live Map ────────────────────┤          └────────┬───────────┘    │
│                                   │          ┌────────▼───────────┐    │
│                                   │          │ Arrived at Pickup  │    │
│                                   │          │ (verify package)   │    │
│                                   │          └────────┬───────────┘    │
│                                   │          ┌────────▼───────────┐    │
│  ◄── Live Map ────────────────────┤          │ En Route Delivery  │    │
│                                   │          └────────┬───────────┘    │
│  RECIPIENT receives notification  │          ┌────────▼───────────┐    │
│                                   │          │ Delivered          │    │
│  ◄── Proof of Delivery ──────────┤          │ (photo proof)      │    │
│                                   │          └────────────────────┘    │
└────────────────────────────────────────────────────────────────────────┘
```

### Courier Pricing

| Component | Value |
|-----------|-------|
| Base Fee | 1,000 GYD |
| Per KM Rate | 300 GYD |
| **Size Surcharge** | |
| SMALL (envelope/document) | +0 GYD |
| MEDIUM (shoebox) | +500 GYD |
| LARGE (moving box) | +1,000 GYD |
| EXTRA_LARGE (furniture) | +2,000 GYD |
| **Speed Multiplier** | |
| Standard (45-60 min) | 1.0x |
| Express (20-30 min) | 1.5x |
| Rush (under 20 min) | 2.0x |

**Example:** LARGE parcel, 8km, Express delivery
= (1,000 + 8 × 300 + 1,000) × 1.5 = **$7,200 GYD**

---

## 10. Authentication & Authorization

### Auth Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                     AUTHENTICATION FLOW                               │
│                                                                      │
│  ┌─────────┐              ┌──────────┐              ┌──────────┐    │
│  │ Mobile  │  POST /auth  │   Auth   │   Store OTP  │  Redis   │    │
│  │  App    │  /send-otp   │  Service │   (5min TTL) │          │    │
│  └────┬────┘──────────────►└────┬─────┘──────────────►└──────────┘    │
│       │                        │                                     │
│       │                        │──── Send SMS ────► Twilio/GTT       │
│       │                        │                                     │
│       │  POST /auth/verify-otp │                                     │
│       │───────────────────────►│                                     │
│       │                        │──── Check Redis OTP                 │
│       │                        │──── Find/Create User                │
│       │                        │──── Generate JWT pair               │
│       │                        │                                     │
│       │◄───────────────────────│    {accessToken, refreshToken,      │
│       │                        │     user, isNewUser}                │
│       │                        │                                     │
│       │  [If isNewUser]        │                                     │
│       │  POST /auth/register   │                                     │
│       │───────────────────────►│──── Set name, email, roles          │
│       │◄───────────────────────│                                     │
│       │                        │                                     │
│  ┌────┴────────────────────────┴──────────────────────────────┐      │
│  │  Subsequent requests: Authorization: Bearer <accessToken> │      │
│  │  Token refresh: POST /auth/refresh {refreshToken}         │      │
│  └───────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

### Multi-Role System

```
  ┌─────────────────────────────────────────────┐
  │              USER ROLES                      │
  │                                              │
  │  A single user can hold MULTIPLE roles:      │
  │                                              │
  │  roles: [CUSTOMER, RIDER, VENDOR_OWNER]      │
  │  activeRole: CUSTOMER ◄── switchable         │
  │                                              │
  │  ┌──────────┐                                │
  │  │ Customer │ ── Browse, Order, Pay          │
  │  ├──────────┤                                │
  │  │  Rider   │ ── Deliver food/parcels        │
  │  ├──────────┤                                │
  │  │ Driver   │ ── Drive taxi rides            │
  │  ├──────────┤                                │
  │  │ Vendor   │ ── Manage restaurant/store     │
  │  ├──────────┤                                │
  │  │  Admin   │ ── Platform management         │
  │  └──────────┘                                │
  │                                              │
  │  POST /api/v1/user/switch-role               │
  │  Body: { "role": "RIDER" }                   │
  │  → Switches activeRole, returns new JWT      │
  └─────────────────────────────────────────────┘
```

---

## 11. Payment & Monetization

### Payment Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                      PAYMENT FLOW                                    │
│                                                                      │
│    ┌─────────┐                                                       │
│    │Customer │                                                       │
│    └────┬────┘                                                       │
│         │                                                            │
│    ┌────▼──────────────────────────────────────┐                     │
│    │ Payment Methods                           │                     │
│    │                                           │                     │
│    │  ┌──────────┐  ┌──────────┐  ┌─────────┐ │                     │
│    │  │   Cash   │  │  Wallet  │  │  Card   │ │                     │
│    │  │ (Primary)│  │ (Prepaid)│  │(Gateway)│ │                     │
│    │  └────┬─────┘  └────┬─────┘  └────┬────┘ │                     │
│    └───────┼─────────────┼─────────────┼──────┘                     │
│            │             │             │                             │
│            ▼             ▼             ▼                             │
│    ┌───────────┐  ┌───────────┐  ┌──────────────┐                   │
│    │ Collect   │  │ Debit     │  │ PowerTranz   │                   │
│    │ on        │  │ Wallet    │  │ Gateway      │                   │
│    │ Delivery  │  │ Balance   │  │ (Card Auth)  │                   │
│    └───────────┘  └───────────┘  └──────────────┘                   │
│                                                                      │
│    ┌────────────────────────────────────────────────────────────┐    │
│    │                  MONEY DISTRIBUTION                        │    │
│    │                                                            │    │
│    │  Order Total: $2,412 GYD                                   │    │
│    │  ┌─────────────────────────────────────────┐               │    │
│    │  │  Vendor Account    $1,432  (base - disc) │               │    │
│    │  │  Rider Earnings    $900    (fee + tip)    │               │    │
│    │  │  Platform Revenue  $80     (5% markup)    │               │    │
│    │  └─────────────────────────────────────────┘               │    │
│    │                                                            │    │
│    │  + Weekly Subscriptions: $10K-20K GYD per provider         │    │
│    └────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### Settlement Cycle

```
  Weekly Settlement (every Monday)
  ─────────────────────────────────

  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
  │  Calculate   │────►│  Deduct      │────►│  Transfer    │
  │  Gross Sales │     │  Markup Cut  │     │  Net Amount  │
  │  per Vendor  │     │  (5% of base)│     │  to Vendor   │
  └──────────────┘     └──────────────┘     └──────────────┘

  Rider/Driver Payout
  ────────────────────

  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
  │  Earnings    │────►│  Deduct      │────►│  Available   │
  │  per Delivery│     │  Subscription│     │  for Payout  │
  │  (auto-calc) │     │  ($10K/20K)  │     │              │
  └──────────────┘     └──────────────┘     └──────────────┘
                                                    │
                                            ┌───────▼───────┐
                                            │ Payout Methods │
                                            │ - Wallet       │
                                            │ - Mobile Money │
                                            │ - Bank Transfer│
                                            │ - Cash Pickup  │
                                            └───────────────┘
```

---

## 12. Maps & Location

### Google Maps Integration

```
┌──────────────────────────────────────────────────────────────────────┐
│                   GOOGLE MAPS PLATFORM USAGE                         │
│                                                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │  Maps SDK            │  │  Directions API      │                 │
│  │  (Mobile)            │  │  (Backend)           │                 │
│  │                      │  │                      │                 │
│  │  - Show map tiles    │  │  - Route calculation │                 │
│  │  - Driver/rider pin  │  │  - ETA estimation    │                 │
│  │  - Pickup/dropoff    │  │  - Distance (meters) │                 │
│  │  - Route polyline    │  │  - Duration (secs)   │                 │
│  │  - Geofence visual   │  │  - Polyline path     │                 │
│  └──────────────────────┘  └──────────────────────┘                 │
│                                                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │  Places API          │  │  Geocoding API       │                 │
│  │  (Mobile)            │  │  (Backend)           │                 │
│  │                      │  │                      │                 │
│  │  - Address search    │  │  - Address → lat/lng │                 │
│  │  - Place autocomplete│  │  - lat/lng → address │                 │
│  │  - Place details     │  │  - Reverse geocoding │                 │
│  └──────────────────────┘  └──────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Real-Time Location Pipeline

```
  Driver/Rider Phone                Server                    Customer Phone
  ──────────────────               ──────                    ──────────────

  GPS Sensor (1Hz)
       │
       ▼
  Batch (3 updates)
       │
       │  PUT /location
       │  {lat, lng, heading,
       │   speed, timestamp}
       │───────────────────────►  Redis GEOADD
       │                          geo:riders:online
       │                               │
       │                          Redis PUBLISH
       │                          channel:order:{id}
       │                               │
       │                               │──────────────────►  Socket.IO
       │                               │                     location:broadcast
       │                               │                          │
       │                               │                     Update map pin
       │                               │                     Animate movement
       │                               │                     Recalculate ETA
```

---

## 13. Push Notifications

### Firebase Cloud Messaging Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    NOTIFICATION SYSTEM                                │
│                                                                      │
│  ┌──────────────┐                                                    │
│  │ Event Source  │ ── Order accepted, Rider assigned, etc.           │
│  └──────┬───────┘                                                    │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────────────────────────────────────┐                │
│  │           Notification Service                    │                │
│  │                                                   │                │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  │                │
│  │  │  In-App    │  │   Push     │  │   SMS      │  │                │
│  │  │  (DB +     │  │   (FCM)    │  │  (Twilio)  │  │                │
│  │  │  Socket.IO)│  │            │  │            │  │                │
│  │  └────────────┘  └────────────┘  └────────────┘  │                │
│  └──────────────────────────────────────────────────┘                │
│                                                                      │
│  Notification Types:                                                 │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ ORDER_UPDATE        │ "Your food is being prepared"            │  │
│  │ RIDER_ASSIGNED      │ "Rider John is on the way to pickup"    │  │
│  │ DELIVERY_ARRIVED    │ "Your order has arrived!"               │  │
│  │ NEW_ORDER_ALERT     │ "New order from customer nearby" (rider)│  │
│  │ RIDE_MATCHED        │ "Driver found! Arriving in 4 min"       │  │
│  │ PAYMENT_RECEIVED    │ "You earned $900 GYD from delivery"     │  │
│  │ SUBSCRIPTION_DUE    │ "Weekly subscription due tomorrow"      │  │
│  │ PROMOTION           │ "50% off your next ride!"               │  │
│  │ EARNING_AVAILABLE   │ "Your earnings are ready for payout"    │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 14. Search & Discovery

### Search Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    SEARCH & DISCOVERY                                 │
│                                                                      │
│  ┌─────────────────┐        ┌──────────────────────────────────┐    │
│  │ Meilisearch     │        │ Search Features                  │    │
│  │                 │        │                                  │    │
│  │ Indexes:        │        │ - Typo tolerance (2 typos)      │    │
│  │ ├── vendors     │        │ - Fuzzy matching                │    │
│  │ ├── items       │        │ - Faceted filtering             │    │
│  │ └── addresses   │        │ - Geo-radius search             │    │
│  │                 │        │ - Ranking by distance + rating  │    │
│  │ Sync:           │        │ - Instant results (<50ms)       │    │
│  │ DB → Meilisearch│        │                                  │    │
│  │ on write events │        │ Fallback: PostgreSQL ILIKE      │    │
│  └─────────────────┘        └──────────────────────────────────┘    │
│                                                                      │
│  Home Feed Algorithm:                                                │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Section 1: Active Order Banner (if exists)                   │    │
│  │ Section 2: Featured Vendors (admin-curated, 5% boost)       │    │
│  │ Section 3: Nearby Vendors (sorted by distance, <10km)       │    │
│  │ Section 4: Order Again (previous vendors, personalized)     │    │
│  │ Section 5: Popular Items (trending in last 24h)             │    │
│  │ Section 6: Categories Grid (Food, Grocery, Pharmacy, etc.) │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 15. Background Jobs & Queues

### BullMQ Job Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     BACKGROUND JOB SYSTEM                            │
│                      (BullMQ + Redis)                                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Queue: ORDER_JOBS                                            │    │
│  │                                                              │    │
│  │ ┌─────────────────┐  Pending order not accepted in 5min     │    │
│  │ │ auto-cancel     │  → Cancel order, refund wallet           │    │
│  │ └─────────────────┘                                          │    │
│  │ ┌─────────────────┐  Delivered order, no action in 30min    │    │
│  │ │ auto-complete   │  → Mark COMPLETED, create earning        │    │
│  │ └─────────────────┘                                          │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Queue: RIDER_ASSIGNMENT                                      │    │
│  │                                                              │    │
│  │ ┌─────────────────┐  Order ready → find nearest rider       │    │
│  │ │ auto-assign     │  → GEORADIUS query, score, offer         │    │
│  │ └─────────────────┘  → 6 attempts, 30s each                 │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Queue: SUBSCRIPTION                                          │    │
│  │                                                              │    │
│  │ ┌─────────────────┐  Weekly check all active subscriptions  │    │
│  │ │ billing-cycle   │  → Debit wallet/charge card              │    │
│  │ └─────────────────┘  → Grace period if insufficient funds    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Queue: SETTLEMENT                                            │    │
│  │                                                              │    │
│  │ ┌─────────────────┐  Weekly vendor settlement calculation   │    │
│  │ │ process-settle  │  → Gross - markup = net payout           │    │
│  │ └─────────────────┘  → Create settlement record              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Queue: NOTIFICATION                                          │    │
│  │                                                              │    │
│  │ ┌─────────────────┐  Send push/SMS/in-app notifications     │    │
│  │ │ dispatch        │  → Batch FCM, throttle SMS               │    │
│  │ └─────────────────┘  → Retry on failure (3 attempts)         │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Queue: SURGE_PRICING                                         │    │
│  │                                                              │    │
│  │ ┌─────────────────┐  Every 60s: recalculate surge per zone  │    │
│  │ │ calculate-surge │  → demand/supply ratio                   │    │
│  │ └─────────────────┘  → Update Redis cache                    │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 16. Deployment Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    DEPLOYMENT ARCHITECTURE                            │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    CDN (Cloudflare)                           │    │
│  │         Static assets, API caching, DDoS protection          │    │
│  └──────────────────────────┬───────────────────────────────────┘    │
│                              │                                       │
│  ┌──────────────────────────▼───────────────────────────────────┐    │
│  │              Load Balancer (Fly.io / AWS ALB)                │    │
│  └────┬──────────────┬──────────────┬──────────────┬────────────┘    │
│       │              │              │              │                  │
│  ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐  ┌─────▼─────┐          │
│  │ API     │   │ API       │  │ Socket  │  │  Admin    │          │
│  │ Server  │   │ Server    │  │ Server  │  │  Panel    │          │
│  │ (Inst 1)│   │ (Inst 2)  │  │ (Inst 1)│  │  (Next.js)│          │
│  └────┬────┘   └─────┬─────┘  └────┬────┘  └───────────┘          │
│       │              │              │                                │
│  ┌────▼──────────────▼──────────────▼────────────────────────┐      │
│  │                   Docker Containers                        │      │
│  │  ┌──────────────────────────────────────────────────┐     │      │
│  │  │            Shared Data Layer                      │     │      │
│  │  │                                                   │     │      │
│  │  │  PostgreSQL 16     Redis 7       Meilisearch     │     │      │
│  │  │  + PostGIS         Cluster       Cluster         │     │      │
│  │  │  (Primary +        (Primary +                    │     │      │
│  │  │   Read Replica)     Replica)                     │     │      │
│  │  └──────────────────────────────────────────────────┘     │      │
│  └───────────────────────────────────────────────────────────┘      │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   External Services                          │    │
│  │                                                              │    │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐             │    │
│  │  │ Firebase   │  │ Google Maps│  │ PowerTranz │             │    │
│  │  │ FCM        │  │ Platform   │  │ Gateway    │             │    │
│  │  └────────────┘  └────────────┘  └────────────┘             │    │
│  │                                                              │    │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐             │    │
│  │  │ Twilio     │  │ AWS S3     │  │ Sentry     │             │    │
│  │  │ SMS        │  │ Storage    │  │ Monitoring │             │    │
│  │  └────────────┘  └────────────┘  └────────────┘             │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    CI/CD (GitHub Actions)                     │    │
│  │                                                              │    │
│  │  push → lint → type-check → test → build → deploy           │    │
│  │                                                              │    │
│  │  Mobile: push → build → TestFlight / Play Console            │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 17. Monorepo Folder Structure

```
swift/
│
├── apps/
│   ├── api/                              # Backend API (Fastify 5 + Prisma)
│   │   ├── prisma/
│   │   │   ├── schema.prisma             # Database schema (29 models)
│   │   │   ├── migrations/               # SQL migrations
│   │   │   └── seed.ts                   # Seed data
│   │   ├── src/
│   │   │   ├── server.ts                 # Entry point
│   │   │   ├── app.ts                    # Fastify app setup
│   │   │   ├── plugins/
│   │   │   │   ├── prisma.ts             # DB connection
│   │   │   │   ├── redis.ts              # Redis client
│   │   │   │   ├── auth.ts               # JWT middleware
│   │   │   │   └── socket.ts             # Socket.IO setup
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   │   ├── auth.routes.ts    # OTP, login, register, refresh
│   │   │   │   │   ├── auth.service.ts   # Auth business logic
│   │   │   │   │   └── auth.schema.ts    # Zod validation
│   │   │   │   ├── user/
│   │   │   │   │   ├── customer.routes.ts # Customer endpoints (30+)
│   │   │   │   │   ├── customer.service.ts
│   │   │   │   │   └── customer.schema.ts
│   │   │   │   ├── vendor/
│   │   │   │   │   ├── vendor.routes.ts  # Vendor endpoints (30)
│   │   │   │   │   ├── vendor.service.ts
│   │   │   │   │   └── vendor.schema.ts
│   │   │   │   ├── rider/
│   │   │   │   │   ├── rider.routes.ts   # Rider endpoints (19)
│   │   │   │   │   ├── rider.service.ts
│   │   │   │   │   └── rider.schema.ts
│   │   │   │   ├── driver/
│   │   │   │   │   ├── driver.routes.ts  # Taxi driver endpoints
│   │   │   │   │   ├── driver.service.ts
│   │   │   │   │   └── driver.schema.ts
│   │   │   │   ├── rides/                # NEW — Rides module
│   │   │   │   │   ├── rides.routes.ts   # Ride request, fare estimate
│   │   │   │   │   ├── rides.service.ts  # Matching, surge, fare calc
│   │   │   │   │   ├── rides.schema.ts
│   │   │   │   │   ├── matching.ts       # Driver matching algorithm
│   │   │   │   │   └── surge.ts          # Surge pricing calculator
│   │   │   │   ├── eats/                 # NEW — Eats module (refactored)
│   │   │   │   │   ├── eats.routes.ts    # Customer-facing food ordering
│   │   │   │   │   ├── eats.service.ts   # Cart, checkout, order flow
│   │   │   │   │   └── eats.schema.ts
│   │   │   │   ├── courier/              # NEW — Courier module
│   │   │   │   │   ├── courier.routes.ts # Parcel endpoints
│   │   │   │   │   ├── courier.service.ts# Sizing, pricing, lifecycle
│   │   │   │   │   └── courier.schema.ts
│   │   │   │   ├── search/
│   │   │   │   │   ├── search.routes.ts
│   │   │   │   │   └── search.service.ts # Meilisearch + DB fallback
│   │   │   │   ├── chat/
│   │   │   │   │   ├── chat.routes.ts
│   │   │   │   │   └── chat.service.ts
│   │   │   │   ├── admin/
│   │   │   │   │   ├── admin.routes.ts   # Admin endpoints (50+)
│   │   │   │   │   ├── admin.service.ts
│   │   │   │   │   └── admin.schema.ts
│   │   │   │   └── notification/
│   │   │   │       ├── notification.service.ts  # FCM + Socket.IO + DB
│   │   │   │       └── notification.types.ts
│   │   │   ├── services/                 # Shared business logic
│   │   │   │   ├── order.service.ts      # Unified order management
│   │   │   │   ├── wallet.service.ts     # Credit/debit/refund
│   │   │   │   ├── rating.service.ts     # Rate & aggregate
│   │   │   │   ├── location.service.ts   # GPS tracking, proximity
│   │   │   │   ├── payment.service.ts    # Payment gateway integration
│   │   │   │   └── subscription.service.ts # Weekly billing
│   │   │   ├── jobs/
│   │   │   │   ├── queue.ts              # BullMQ queue setup
│   │   │   │   ├── order.jobs.ts         # Auto-cancel, auto-complete
│   │   │   │   ├── rider-assignment.jobs.ts # Auto-assign riders
│   │   │   │   ├── subscription.jobs.ts  # Billing cycle
│   │   │   │   ├── settlement.jobs.ts    # Vendor payouts
│   │   │   │   ├── surge.jobs.ts         # Surge recalculation
│   │   │   │   └── notification.jobs.ts  # Batch dispatch
│   │   │   ├── utils/
│   │   │   │   ├── markup.ts             # 5% markup calculation
│   │   │   │   ├── distance.ts           # Haversine formula
│   │   │   │   ├── fare.ts               # Taxi fare calculator
│   │   │   │   ├── pagination.ts         # Cursor/offset helpers
│   │   │   │   ├── otp.ts               # OTP generation
│   │   │   │   └── errors.ts            # AppError classes
│   │   │   └── middleware/
│   │   │       ├── error-handler.ts      # Global error handler
│   │   │       └── role-guard.ts         # Role-based access control
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   │   ├── markup.test.ts
│   │   │   │   ├── distance.test.ts
│   │   │   │   ├── fare.test.ts
│   │   │   │   ├── otp.test.ts
│   │   │   │   └── surge.test.ts
│   │   │   └── integration/
│   │   │       ├── auth.test.ts
│   │   │       ├── order-lifecycle.test.ts
│   │   │       └── ride-lifecycle.test.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   │
│   ├── mobile-flutter/                   # Flutter Mobile App (PRIMARY)
│   │   ├── android/
│   │   ├── ios/
│   │   ├── lib/
│   │   │   ├── main.dart                 # App entry point
│   │   │   ├── app.dart                  # MaterialApp + routing
│   │   │   ├── core/
│   │   │   │   ├── constants/
│   │   │   │   │   ├── app_colors.dart   # Black & white theme
│   │   │   │   │   ├── app_typography.dart
│   │   │   │   │   └── api_endpoints.dart
│   │   │   │   ├── network/
│   │   │   │   │   ├── api_client.dart   # Dio HTTP client
│   │   │   │   │   ├── api_interceptor.dart # JWT attach/refresh
│   │   │   │   │   └── socket_client.dart # Socket.IO wrapper
│   │   │   │   ├── storage/
│   │   │   │   │   └── secure_storage.dart # Token storage
│   │   │   │   ├── routing/
│   │   │   │   │   ├── app_router.dart   # GoRouter setup
│   │   │   │   │   └── route_guards.dart # Auth/role guards
│   │   │   │   └── theme/
│   │   │   │       ├── app_theme.dart    # Light + dark themes
│   │   │   │       └── widgets/          # Reusable design system
│   │   │   │           ├── swift_button.dart
│   │   │   │           ├── swift_card.dart
│   │   │   │           ├── swift_input.dart
│   │   │   │           ├── swift_bottom_sheet.dart
│   │   │   │           └── swift_loading.dart
│   │   │   ├── features/
│   │   │   │   ├── auth/
│   │   │   │   │   ├── data/
│   │   │   │   │   │   ├── auth_repository.dart
│   │   │   │   │   │   └── auth_api.dart
│   │   │   │   │   ├── domain/
│   │   │   │   │   │   └── auth_state.dart
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── phone_entry_screen.dart
│   │   │   │   │       ├── otp_screen.dart
│   │   │   │   │       └── register_screen.dart
│   │   │   │   ├── home/
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── home_screen.dart        # Tab container
│   │   │   │   │       └── widgets/
│   │   │   │   │           ├── module_switcher.dart # Rides|Eats|Courier
│   │   │   │   │           └── active_order_banner.dart
│   │   │   │   ├── rides/                          # MODULE A
│   │   │   │   │   ├── data/
│   │   │   │   │   │   ├── rides_repository.dart
│   │   │   │   │   │   └── rides_api.dart
│   │   │   │   │   ├── domain/
│   │   │   │   │   │   ├── ride_state.dart
│   │   │   │   │   │   └── car_type.dart
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── rides_home_screen.dart   # Map + destination
│   │   │   │   │       ├── ride_options_screen.dart  # Car selection
│   │   │   │   │       ├── ride_matching_screen.dart # Finding driver
│   │   │   │   │       ├── ride_tracking_screen.dart # Live trip
│   │   │   │   │       ├── ride_receipt_screen.dart  # Trip summary
│   │   │   │   │       └── widgets/
│   │   │   │   │           ├── car_type_card.dart
│   │   │   │   │           ├── fare_estimate.dart
│   │   │   │   │           ├── driver_info_card.dart
│   │   │   │   │           └── surge_badge.dart
│   │   │   │   ├── eats/                           # MODULE B
│   │   │   │   │   ├── data/
│   │   │   │   │   │   ├── eats_repository.dart
│   │   │   │   │   │   └── eats_api.dart
│   │   │   │   │   ├── domain/
│   │   │   │   │   │   ├── cart_state.dart
│   │   │   │   │   │   └── menu_models.dart
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── eats_home_screen.dart    # Featured + search
│   │   │   │   │       ├── vendor_screen.dart       # Menu + reviews
│   │   │   │   │       ├── cart_screen.dart          # Cart + checkout
│   │   │   │   │       ├── order_tracking_screen.dart# Live delivery
│   │   │   │   │       └── widgets/
│   │   │   │   │           ├── vendor_card.dart
│   │   │   │   │           ├── menu_item_card.dart
│   │   │   │   │           ├── cart_summary.dart
│   │   │   │   │           └── order_timeline.dart
│   │   │   │   ├── courier/                        # MODULE C
│   │   │   │   │   ├── data/
│   │   │   │   │   │   ├── courier_repository.dart
│   │   │   │   │   │   └── courier_api.dart
│   │   │   │   │   ├── domain/
│   │   │   │   │   │   └── parcel_state.dart
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── courier_home_screen.dart  # New parcel form
│   │   │   │   │       ├── courier_tracking_screen.dart
│   │   │   │   │       └── widgets/
│   │   │   │   │           ├── package_size_picker.dart
│   │   │   │   │           ├── speed_selector.dart
│   │   │   │   │           └── parcel_price_card.dart
│   │   │   │   ├── rider/                          # Rider Mode
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── rider_home_screen.dart
│   │   │   │   │       ├── available_orders_screen.dart
│   │   │   │   │       ├── active_delivery_screen.dart
│   │   │   │   │       └── rider_earnings_screen.dart
│   │   │   │   ├── driver/                         # Driver Mode
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── driver_home_screen.dart
│   │   │   │   │       ├── available_rides_screen.dart
│   │   │   │   │       ├── active_ride_screen.dart
│   │   │   │   │       └── driver_earnings_screen.dart
│   │   │   │   ├── vendor/                         # Vendor Mode
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── vendor_orders_screen.dart
│   │   │   │   │       ├── menu_management_screen.dart
│   │   │   │   │       └── vendor_analytics_screen.dart
│   │   │   │   ├── wallet/
│   │   │   │   │   └── presentation/
│   │   │   │   │       ├── wallet_screen.dart
│   │   │   │   │       └── transaction_history_screen.dart
│   │   │   │   ├── notifications/
│   │   │   │   │   └── presentation/
│   │   │   │   │       └── notifications_screen.dart
│   │   │   │   └── profile/
│   │   │   │       └── presentation/
│   │   │   │           ├── profile_screen.dart
│   │   │   │           ├── addresses_screen.dart
│   │   │   │           └── settings_screen.dart
│   │   │   └── shared/
│   │   │       ├── providers/                # Riverpod providers
│   │   │       │   ├── auth_provider.dart
│   │   │       │   ├── location_provider.dart
│   │   │       │   └── socket_provider.dart
│   │   │       ├── models/                   # Shared data models
│   │   │       │   ├── user.dart
│   │   │       │   ├── order.dart
│   │   │       │   ├── vendor.dart
│   │   │       │   └── location.dart
│   │   │       └── widgets/                  # Shared widgets
│   │   │           ├── map_view.dart
│   │   │           ├── address_picker.dart
│   │   │           ├── rating_stars.dart
│   │   │           └── price_display.dart
│   │   ├── test/
│   │   ├── pubspec.yaml
│   │   └── analysis_options.yaml
│   │
│   ├── mobile/                               # React Native App (EXISTING)
│   │   ├── src/
│   │   │   ├── screens/
│   │   │   │   ├── auth/
│   │   │   │   ├── customer/
│   │   │   │   ├── rider/
│   │   │   │   ├── driver/
│   │   │   │   ├── vendor/
│   │   │   │   └── shared/
│   │   │   ├── navigation/
│   │   │   ├── state/                        # Zustand stores
│   │   │   ├── services/                     # API + Socket
│   │   │   └── components/                   # Reusable UI
│   │   ├── android/
│   │   ├── ios/
│   │   └── package.json
│   │
│   └── admin/                                # Next.js Admin Dashboard
│       ├── src/
│       │   ├── app/                          # App Router pages
│       │   │   ├── dashboard/
│       │   │   ├── users/
│       │   │   ├── vendors/
│       │   │   ├── riders/
│       │   │   ├── drivers/
│       │   │   ├── orders/
│       │   │   ├── finance/
│       │   │   ├── zones/
│       │   │   ├── promos/
│       │   │   ├── config/
│       │   │   └── audit/
│       │   ├── components/
│       │   ├── hooks/
│       │   ├── lib/
│       │   └── styles/
│       └── package.json
│
├── packages/                                 # Shared Packages
│   ├── types/                                # @swift/types
│   │   └── src/
│   │       ├── user.ts
│   │       ├── order.ts
│   │       ├── vendor.ts
│   │       ├── rider.ts
│   │       ├── driver.ts
│   │       ├── rides.ts                      # NEW — ride types
│   │       ├── courier.ts                    # NEW — courier types
│   │       ├── subscription.ts
│   │       ├── finance.ts
│   │       ├── notification.ts
│   │       ├── rating.ts
│   │       ├── websocket.ts
│   │       ├── cart.ts
│   │       ├── api.ts
│   │       └── index.ts
│   ├── config/                               # @swift/config
│   │   └── src/
│   │       ├── pricing.ts                    # Markup %, fees, surge
│   │       ├── car-types.ts                  # NEW — vehicle configs
│   │       └── index.ts
│   ├── utils/                                # @swift/utils
│   │   └── src/
│   │       ├── formatters.ts                 # Currency, date, distance
│   │       ├── validators.ts                 # Phone, email, GYD amounts
│   │       └── index.ts
│   └── api-client/                           # @swift/api-client (shared HTTP)
│       └── src/
│           ├── client.ts
│           └── endpoints.ts
│
├── infrastructure/
│   ├── docker/
│   │   ├── docker-compose.yml                # PostgreSQL + Redis + Meilisearch
│   │   ├── Dockerfile.api                    # API production image
│   │   ├── Dockerfile.admin                  # Admin production image
│   │   └── nginx.conf                        # Reverse proxy config
│   ├── k8s/                                  # Kubernetes manifests (future)
│   │   ├── api-deployment.yaml
│   │   ├── redis-deployment.yaml
│   │   └── ingress.yaml
│   └── scripts/
│       ├── setup.sh                          # One-command dev setup
│       ├── seed.sh                           # Seed database
│       └── migrate.sh                        # Run migrations
│
├── docs/
│   ├── SYSTEM_DESIGN.md                      # This document
│   ├── API_REFERENCE.md                      # Endpoint documentation
│   └── DEPLOYMENT.md                         # Deploy guide
│
├── .github/
│   └── workflows/
│       ├── ci.yml                            # Lint + test + build
│       ├── deploy-api.yml                    # Deploy API to Fly.io
│       ├── deploy-admin.yml                  # Deploy admin to Vercel
│       └── build-mobile.yml                  # Build Flutter/RN
│
├── turbo.json                                # Turborepo task config
├── pnpm-workspace.yaml                       # Workspace definition
├── package.json                              # Root scripts
├── tsconfig.base.json                        # Shared TS config
├── .gitignore
├── .env.example
└── .nvmrc                                    # Node version (20+)
```

---

## 18. UI/UX: Home Screen & Navigation

### Bottom Tab Navigation

```
┌──────────────────────────────────────────────────┐
│                   STATUS BAR                      │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │    📍 Georgetown, Guyana          🔔  👤 │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │     ┌────────┬────────┬────────┐         │    │
│  │     │ Rides  │  Eats  │Courier │         │    │
│  │     │  ━━━   │        │        │  ◄─ Tab │    │
│  │     └────────┴────────┴────────┘   Switcher   │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ╔══════════════════════════════════════════╗    │
│  ║                                          ║    │
│  ║   RIDES TAB (Active):                    ║    │
│  ║                                          ║    │
│  ║   ┌──────────────────────────────────┐   ║    │
│  ║   │       🗺️  MAP VIEW               │   ║    │
│  ║   │                                  │   ║    │
│  ║   │    Your location pin shown       │   ║    │
│  ║   │    Nearby drivers shown          │   ║    │
│  ║   │                                  │   ║    │
│  ║   └──────────────────────────────────┘   ║    │
│  ║                                          ║    │
│  ║   ┌──────────────────────────────────┐   ║    │
│  ║   │  🔍  Where to?                   │   ║    │
│  ║   └──────────────────────────────────┘   ║    │
│  ║                                          ║    │
│  ║   ┌──────────┐  ┌──────────┐             ║    │
│  ║   │ 🏠 Home  │  │ 🏢 Work  │  Saved     ║    │
│  ║   │ 14 min   │  │ 22 min   │  Places    ║    │
│  ║   └──────────┘  └──────────┘             ║    │
│  ║                                          ║    │
│  ╚══════════════════════════════════════════╝    │
│                                                  │
│  ╔══════════════════════════════════════════╗    │
│  ║   EATS TAB:                              ║    │
│  ║                                          ║    │
│  ║   🔍 Search food, restaurants...         ║    │
│  ║                                          ║    │
│  ║   [Active Order Banner - if any]         ║    │
│  ║                                          ║    │
│  ║   ── Featured ──────────────────         ║    │
│  ║   [Vendor Card] [Vendor Card] →          ║    │
│  ║                                          ║    │
│  ║   ── Nearby ────────────────────         ║    │
│  ║   [Vendor Card] [Vendor Card] →          ║    │
│  ║                                          ║    │
│  ║   ── Categories ────────────────         ║    │
│  ║   [🍗] [🍕] [🛒] [💊] [🥤]             ║    │
│  ╚══════════════════════════════════════════╝    │
│                                                  │
│  ╔══════════════════════════════════════════╗    │
│  ║   COURIER TAB:                           ║    │
│  ║                                          ║    │
│  ║   ┌──────────────────────────────────┐   ║    │
│  ║   │  Send a Package                  │   ║    │
│  ║   │                                  │   ║    │
│  ║   │  📍 Pickup: [Enter address]      │   ║    │
│  ║   │  📍 Dropoff: [Enter address]     │   ║    │
│  ║   │                                  │   ║    │
│  ║   │  📦 Size: [S] [M] [L] [XL]      │   ║    │
│  ║   │  ⚡ Speed: [Standard] [Express]  │   ║    │
│  ║   │                                  │   ║    │
│  ║   │  [Get Price Quote →]             │   ║    │
│  ║   └──────────────────────────────────┘   ║    │
│  ╚══════════════════════════════════════════╝    │
│                                                  │
├──────────────────────────────────────────────────┤
│  ┌────────┬────────┬────────┬────────┐           │
│  │  🏠    │  📋    │  💰    │  👤    │           │
│  │  Home  │ Orders │ Wallet │ Account│           │
│  │  ━━━   │        │        │        │           │
│  └────────┴────────┴────────┴────────┘           │
│              BOTTOM NAVIGATION BAR               │
└──────────────────────────────────────────────────┘
```

### Role-Based Navigation

```
  CUSTOMER MODE                 RIDER/DRIVER MODE           VENDOR MODE
  ─────────────                 ─────────────────           ───────────

  ┌──────────────┐              ┌──────────────┐            ┌──────────────┐
  │ Home         │              │ Home         │            │ Orders       │
  │ (Rides/Eats/ │              │ (Go Online/  │            │ (Incoming/   │
  │  Courier)    │              │  Offline)    │            │  Active)     │
  ├──────────────┤              ├──────────────┤            ├──────────────┤
  │ Orders       │              │ Available    │            │ Menu         │
  │ (History)    │              │ (Nearby jobs)│            │ (CRUD)       │
  ├──────────────┤              ├──────────────┤            ├──────────────┤
  │ Wallet       │              │ Earnings     │            │ Analytics    │
  │ (Balance)    │              │ (Today/Week) │            │ (Revenue)    │
  ├──────────────┤              ├──────────────┤            ├──────────────┤
  │ Account      │              │ Account      │            │ Account      │
  │ (Profile)    │              │ (Profile)    │            │ (Profile)    │
  └──────────────┘              └──────────────┘            └──────────────┘

  All modes accessible via role switch in Account → Switch Role
```

---

## Summary

This system design builds on Swift's **existing, production-ready codebase** (8,000+ lines of API code, 105 tests, 100+ endpoints) and extends it with:

1. **Flutter mobile client** as the primary app alongside the existing React Native app
2. **Modular architecture** with clear domain boundaries (Rides, Eats, Courier)
3. **Uber-grade features**: surge pricing, driver matching algorithms, real-time tracking
4. **Proven monetization**: 5% invisible markup + weekly subscriptions
5. **Scalability path**: modular monolith today, extractable microservices tomorrow

The existing Swift API already implements ~80% of the backend logic. The primary work ahead is:
- Building the Flutter mobile client
- Adding the rides module (driver matching, surge pricing, fare calculation)
- Enhancing the courier module (package sizing, speed tiers)
- Deploying to production infrastructure
