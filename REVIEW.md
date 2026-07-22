# WhatsApp Bot Improvement Plan (Priority)

## 1. Handle Client Disconnect
**Current Issue:**
- `isClientReady` hanya di-set menjadi `true` saat event `ready`.
- Jika WhatsApp logout atau koneksi terputus, API masih menganggap client siap.

**Improvement:**
- Tambahkan event `disconnected`.
- Set `isClientReady = false`.
- Log alasan disconnect.

**Example:**
```javascript
client.on('disconnected', reason => {
    console.log('WhatsApp disconnected:', reason);
    isClientReady = false;
});
```

---

## 2. Auto Reconnect
**Current Issue:**
- Setelah disconnect, bot tidak mencoba connect kembali.

**Improvement:**
- Pada event `disconnected`, panggil kembali `startBot()`.
- Tambahkan delay sebelum reconnect agar tidak looping terlalu cepat.

**Example:**
```javascript
client.on('disconnected', async reason => {
    console.log('Disconnected:', reason);
    isClientReady = false;

    await new Promise(resolve => setTimeout(resolve, 5000));

    await startBot();
});
```

---

## 3. Isolate Error Per Recipient
**Current Issue:**
- Jika satu nomor gagal dikirim, seluruh proses dapat berhenti.

**Improvement:**
- Bungkus setiap pengiriman dengan `try/catch`.
- Lanjutkan ke nomor berikutnya meskipun ada error.

**Example:**
```javascript
for (const number of numbers) {
    try {
        ...
        await client.sendMessage(...);
    } catch (err) {
        results.push({
            number,
            status: "error",
            error: err.message
        });
    }
}
```

---

## 4. Timeout getNumberId()
**Current Issue:**
- `getNumberId()` terkadang menggantung cukup lama.

**Improvement:**
- Tambahkan timeout menggunakan `Promise.race()`.

**Example:**
```javascript
function timeout(ms) {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), ms)
    );
}

const numberDetails = await Promise.race([
    client.getNumberId(cleanNumber),
    timeout(10000)
]);
```

---

## 5. Request Logging
**Current Issue:**
- Tidak ada audit log request yang masuk.

**Improvement:**
Catat informasi berikut:
- Timestamp
- Client IP
- Jumlah nomor
- Group ID
- Status request
- Durasi request

Contoh log:
```
2026-07-22 08:00:11
POST /api/notify
IP: xxx.xxx.xxx.xxx
Numbers: 15
Group: -
Status: SUCCESS
Duration: 8.2 sec
```

---

## 6. Secure API Key Comparison
**Current Issue:**
- API Key dibandingkan menggunakan operator `!==`.

**Improvement:**
Gunakan `crypto.timingSafeEqual()` agar lebih aman terhadap timing attack.

**Example:**
```javascript
const crypto = require("crypto");
```

Lalu gunakan secure comparison dibanding string comparison biasa.

---

## 7. Add Rate Limiter
**Current Issue:**
- Endpoint dapat dipanggil tanpa batas.

**Improvement:**
Gunakan package:

```
express-rate-limit
```

Contoh limit:

- 100 request
- setiap 15 menit
- per IP

Hal ini mencegah abuse maupun spam.

---

## 8. Health Check Endpoint
**Current Issue:**
- Tidak ada endpoint untuk mengetahui status bot.

**Improvement:**
Tambahkan endpoint:

```
GET /health
```

Contoh response:

```json
{
    "status": "ok",
    "ready": true,
    "authenticated": true,
    "uptime": 123456
}
```

Berguna untuk:
- Railway
- Render
- UptimeRobot
- Monitoring Dashboard

---

## 9. Better Phone Number Normalization
**Current Issue:**
- Saat ini hanya mendukung nomor Indonesia yang diawali angka `0`.

**Improvement:**
Pindahkan proses normalisasi ke fungsi terpisah.

Contoh:

```javascript
function normalizeNumber(number) {
    let clean = number.toString().replace(/\D/g, '');

    if (clean.startsWith('0')) {
        clean = '62' + clean.substring(1);
    }

    return clean;
}
```

Ke depannya dapat menggunakan:

- libphonenumber-js

agar mendukung banyak negara.

---

## 10. Queue Message Sending
**Current Issue:**
- API mengirim semua pesan secara langsung.
- Jika ada ratusan nomor, request menjadi sangat lama.

**Improvement:**

Flow yang disarankan:

```
API Request
      │
      ▼
 Message Queue
      │
      ▼
 Worker
      │
      ▼
 WhatsApp
```

Rekomendasi queue:

- BullMQ + Redis (Production)
- PQueue (Simple)
- BeeQueue

Keuntungan:

- Tidak timeout.
- Retry otomatis.
- Bisa pause/resume.
- Progress pengiriman.
- Skalabilitas lebih baik.

---

# Future Improvements (Optional)

Selain 10 poin di atas, beberapa fitur yang sangat direkomendasikan:

- Template message (`{{name}}`, `{{amount}}`, `{{due_date}}`)
- Media attachment (gambar, PDF, invoice)
- Retry otomatis ketika sendMessage gagal
- Delivery log ke PostgreSQL
- Dashboard monitoring
- Broadcast progress (mis. 120/500 terkirim)
- Admin endpoint untuk cek status WhatsApp
- Queue monitoring
- Structured logging (Winston/Pino)
- Graceful shutdown (`SIGINT`, `SIGTERM`)
- Unit test untuk utility function
- Centralized error handler
- Config validation saat startup
- Docker healthcheck
- Metrics (Prometheus/Grafana)

---

# Priority Order

| Priority | Improvement |
|----------|-------------|
| ⭐⭐⭐⭐⭐ | Handle Disconnect |
| ⭐⭐⭐⭐⭐ | Auto Reconnect |
| ⭐⭐⭐⭐⭐ | Error Isolation Per Recipient |
| ⭐⭐⭐⭐☆ | Queue Message Sending |
| ⭐⭐⭐⭐☆ | Health Endpoint |
| ⭐⭐⭐⭐☆ | Request Logging |
| ⭐⭐⭐☆☆ | Timeout getNumberId |
| ⭐⭐⭐☆☆ | Rate Limiter |
| ⭐⭐☆☆☆ | Secure API Key Comparison |
| ⭐⭐☆☆☆ | Better Phone Number Normalization |

Target implementasi 10 poin di atas akan membuat bot jauh lebih **reliable**, **aman**, **mudah dimonitor**, dan **siap digunakan pada lingkungan production**.