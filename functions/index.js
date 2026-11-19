/* eslint-disable */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// ============================================================
// إعدادات بوابة الدفع - القاصة (Alqaseh)
// ============================================================
const ALQASEH_CLIENT_ID = process.env.ALQASEH_CLIENT_ID || "public_test";
const ALQASEH_CLIENT_SECRET =
  process.env.ALQASEH_CLIENT_SECRET || "Lr10yWWmm1dXLoI7VgXCrQVnlq13c1G0";
const ALQASEH_BASE_URL =
  process.env.ALQASEH_BASE_URL || "https://api-test.alqaseh.com/v1";
const ALQASEH_CHECKOUT_URL =
  process.env.ALQASEH_CHECKOUT_URL || "https://pay-test.alqaseh.com/pay";

const SUBSCRIPTION_PRICE_IQD = 5000;
const SUBSCRIPTION_DAYS = 90;

const REDIRECT_URL = "gymapp://payment/result";
const WEBHOOK_URL =
  "https://us-central1-archif-91c29.cloudfunctions.net/alqasehWebhook";

// 📚 أسماء المجموعات
const COLLECTION_ORDERS = "payment_orders";
const COLLECTION_TX = "payment_transactions";
const COLLECTION_LOGS = "activation_logs";

// ============================================================
// 🛠️ دوال مساعدة
// ============================================================
function buildAuthHeader() {
  const credentials = `${ALQASEH_CLIENT_ID}:${ALQASEH_CLIENT_SECRET}`;
  const token = Buffer.from(credentials).toString("base64");
  return `Basic ${token}`;
}

function generateShortOrderId(uid) {
  const shortUid = uid.slice(-8);
  const shortTs = Date.now().toString().slice(-10);
  return `ord_${shortUid}_${shortTs}`;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * 🎯 حساب التواريخ الجديدة:
 * - إذا الاشتراك ساري → أضف فوق endDate الحالي
 * - إذا منتهي أو جديد → ابدأ من الآن
 */
function computeNewSubscriptionDates(subRaw, daysToAdd) {
  const now = new Date();
  const currentEnd = toDate(subRaw && subRaw.endDate);
  const currentStart = toDate(subRaw && subRaw.startDate);

  const isCurrentlyActive =
    currentEnd && currentEnd.getTime() > now.getTime();

  const baseDate = isCurrentlyActive ? currentEnd : now;
  const newEnd = new Date(
    baseDate.getTime() + daysToAdd * 24 * 60 * 60 * 1000
  );
  const newStart = isCurrentlyActive && currentStart ? currentStart : now;

  return {
    isCurrentlyActive,
    currentEnd,
    newStart,
    newEnd,
    totalRemaining: Math.ceil(
      (newEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
    ),
  };
}

// ============================================================
// 1) إنشاء طلب دفع + سجل في payment_transactions
// ============================================================
exports.createAlqasehPayment = functions.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "يجب تسجيل الدخول أولاً."
      );
    }
    const uid = context.auth.uid;

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError("not-found", "المستخدم غير موجود.");
    }
    const user = userDoc.data();
    const email = user.email || "";
    const displayName = user.displayName || "";

    const orderId = generateShortOrderId(uid);
    console.log("Generated orderId:", orderId, "length:", orderId.length);

    const payload = {
      amount: SUBSCRIPTION_PRICE_IQD,
      currency: "IQD",
      description: `تفعيل اشتراك ${SUBSCRIPTION_DAYS} يوم`,
      order_id: orderId,
      redirect_url: REDIRECT_URL,
      transaction_type: "Retail",
      email: email,
      country: "IQ",
      webhook_url: WEBHOOK_URL,
      custom_data: {
        user_id: uid,
        subscription_days: SUBSCRIPTION_DAYS,
      },
      token_expiry_in_hour: 2,
    };

    console.log("Payload:", JSON.stringify(payload));

    try {
      const resp = await axios.post(
        `${ALQASEH_BASE_URL}/egw/payments/create`,
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: buildAuthHeader(),
          },
          timeout: 30000,
        }
      );

      const resData = resp.data || {};
      const paymentId = resData.payment_id || resData.id || null;
      const token = resData.token || resData.payment_token || null;
      const paymentUrl = token ? `${ALQASEH_CHECKOUT_URL}/${token}` : null;

      const now = admin.firestore.FieldValue.serverTimestamp();

      // 1أ) طلب الدفع
      await db.collection(COLLECTION_ORDERS).doc(orderId).set({
        orderId: orderId,
        paymentId: paymentId,
        userId: uid,
        email: email,
        amount: SUBSCRIPTION_PRICE_IQD,
        days: SUBSCRIPTION_DAYS,
        status: "pending",
        paymentUrl: paymentUrl,
        createdAt: now,
      });

      // 1ب) 🔥 سجل العملية
      await db.collection(COLLECTION_TX).doc(orderId).set({
        orderId: orderId,
        paymentId: paymentId,
        userId: uid,
        userEmail: email,
        userName: displayName,
        amount: SUBSCRIPTION_PRICE_IQD,
        currency: "IQD",
        days: SUBSCRIPTION_DAYS,
        status: "pending",
        paymentMethod: "alqaseh_card",
        isSandbox: ALQASEH_BASE_URL.includes("test"),
        paymentUrl: paymentUrl,
        createdAt: now,
      });

      if (!paymentUrl) {
        return {
          success: false,
          message: "لم يتم استلام token من بوابة القاصة.",
          raw: resData,
        };
      }

      return {
        success: true,
        paymentUrl: paymentUrl,
        orderId: orderId,
        paymentId: paymentId,
      };
    } catch (e) {
      const errMsg =
        (e.response && e.response.data && e.response.data.message) ||
        e.message ||
        "خطأ غير معروف";
      console.error("createAlqasehPayment ERROR:", errMsg);
      throw new functions.https.HttpsError(
        "internal",
        "فشل إنشاء طلب الدفع: " + errMsg
      );
    }
  }
);

// ============================================================
// 2) التحقق من الدفع + سجل في activation_logs
// ============================================================
exports.verifyAlqasehPayment = functions.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "يجب تسجيل الدخول أولاً."
      );
    }
    const uid = context.auth.uid;
    const orderId = data && data.orderId ? data.orderId : null;

    try {
      let orderRef;
      let orderData;

      if (orderId) {
        orderRef = db.collection(COLLECTION_ORDERS).doc(orderId);
        const doc = await orderRef.get();
        if (!doc.exists) {
          throw new functions.https.HttpsError(
            "not-found",
            "طلب الدفع غير موجود."
          );
        }
        orderData = doc.data();
      } else {
        const snap = await db
          .collection(COLLECTION_ORDERS)
          .where("userId", "==", uid)
          .limit(50)
          .get();

        const orders = snap.docs
          .map((d) => ({ ref: d.ref, data: d.data() }))
          .filter((o) => o.data.status === "pending")
          .sort((a, b) => {
            const aT = a.data.createdAt && a.data.createdAt.seconds
              ? a.data.createdAt.seconds
              : 0;
            const bT = b.data.createdAt && b.data.createdAt.seconds
              ? b.data.createdAt.seconds
              : 0;
            return bT - aT;
          });

        if (orders.length === 0) {
          return { success: false, message: "لا توجد عملية دفع معلقة." };
        }
        orderRef = orders[0].ref;
        orderData = orders[0].data;
      }

      if (orderData.status === "completed") {
        return {
          success: true,
          message: "تم تفعيل هذا الطلب مسبقاً.",
          alreadyProcessed: true,
        };
      }

      // استعلام حالة الدفع
      const historyResp = await axios.get(
        `${ALQASEH_BASE_URL}/egw/payments/history`,
        {
          params: { order_id: orderData.orderId },
          headers: { Authorization: buildAuthHeader() },
          timeout: 30000,
        }
      );

      console.log(
        "Alqaseh history response:",
        JSON.stringify(historyResp.data).substring(0, 1000)
      );

      let payments = historyResp.data;
      if (
        payments &&
        !Array.isArray(payments) &&
        Array.isArray(payments.data)
      ) {
        payments = payments.data;
      }
      if (!payments || payments.length === 0) {
        return {
          success: false,
          message: "لم يتم العثور على عملية الدفع بعد.",
        };
      }

      const latest = payments[0];
      const status = (
        latest.payment_status ||
        latest.status ||
        ""
      ).toLowerCase();

      // ❌ حالات الفشل
      if (
        status === "failed" ||
        status === "declined" ||
        status === "canceled" ||
        status === "cancelled" ||
        status === "expired"
      ) {
        await orderRef.update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failureReason: status,
        });
        // تحديث السجل
        await db.collection(COLLECTION_TX).doc(orderData.orderId).set(
          {
            status: "failed",
            failureReason: status,
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return { success: false, message: `فشلت عملية الدفع (${status}).` };
      }

      // ✅ حالة النجاح
      if (
        status === "succeeded" ||
        status === "success" ||
        status === "paid"
      ) {
        const result = await db.runTransaction(async (transaction) => {
          const orderRefTx = db
            .collection(COLLECTION_ORDERS)
            .doc(orderData.orderId);
          const orderSnap = await transaction.get(orderRefTx);
          const freshOrder = orderSnap.data() || {};

          if (freshOrder.status === "completed") {
            return {
              alreadyProcessed: true,
              message: "تم تفعيل هذا الطلب مسبقاً.",
            };
          }

          const userRef = db.collection("users").doc(uid);
          const userSnap = await transaction.get(userRef);
          if (!userSnap.exists) {
            throw new Error("المستخدم غير موجود.");
          }

          const userData = userSnap.data() || {};
          const sub = userData.subscription || {};
          const daysToAdd = freshOrder.days || SUBSCRIPTION_DAYS;

          const {
            isCurrentlyActive,
            currentEnd,
            newStart,
            newEnd,
            totalRemaining,
          } = computeNewSubscriptionDates(sub, daysToAdd);

          // 1) تحديث المستخدم
          transaction.update(userRef, {
            "subscription.status": "active",
            "subscription.startDate": admin.firestore.Timestamp.fromDate(
              newStart
            ),
            "subscription.endDate": admin.firestore.Timestamp.fromDate(
              newEnd
            ),
            "subscription.plan": `${daysToAdd}_days_paid`,
            "subscription.paymentMethod": "alqaseh_card",
            "subscription.paymentAmount":
              freshOrder.amount || SUBSCRIPTION_PRICE_IQD,
            "subscription.paymentId":
              latest.payment_id || freshOrder.paymentId || null,
            "subscription.lastOrderId": freshOrder.orderId,
            "subscription.activatedAt":
              admin.firestore.FieldValue.serverTimestamp(),
            "subscription.wasExtension": isCurrentlyActive,
          });

          // 2) تحديث طلب الدفع
          transaction.update(orderRefTx, {
            status: "completed",
            paymentId: latest.payment_id || freshOrder.paymentId || null,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            previousEndDate: currentEnd
              ? admin.firestore.Timestamp.fromDate(currentEnd)
              : null,
            newEndDate: admin.firestore.Timestamp.fromDate(newEnd),
            daysAdded: daysToAdd,
            wasExtension: isCurrentlyActive,
          });

          // 3) تحديث سجل الدفع
          const txRef = db
            .collection(COLLECTION_TX)
            .doc(freshOrder.orderId);
          transaction.set(
            txRef,
            {
              status: "succeeded",
              paymentId:
                latest.payment_id || freshOrder.paymentId || null,
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
              previousEndDate: currentEnd
                ? admin.firestore.Timestamp.fromDate(currentEnd)
                : null,
              newEndDate: admin.firestore.Timestamp.fromDate(newEnd),
              daysAdded: daysToAdd,
              wasExtension: isCurrentlyActive,
              totalRemaining: totalRemaining,
            },
            { merge: true }
          );

          // 4) سجل التفعيل
          const logRef = db.collection(COLLECTION_LOGS).doc();
          transaction.set(logRef, {
            logId: logRef.id,
            userId: uid,
            userName: userData.displayName || "",
            userEmail: userData.email || "",
            type: "payment_activation",
            source: "alqaseh_card",
            orderId: freshOrder.orderId,
            paymentId:
              latest.payment_id || freshOrder.paymentId || null,
            daysAdded: daysToAdd,
            wasExtension: isCurrentlyActive,
            previousEndDate: currentEnd
              ? admin.firestore.Timestamp.fromDate(currentEnd)
              : null,
            newEndDate: admin.firestore.Timestamp.fromDate(newEnd),
            amount: freshOrder.amount || SUBSCRIPTION_PRICE_IQD,
            currency: "IQD",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          return {
            alreadyProcessed: false,
            wasExtension: isCurrentlyActive,
            daysAdded: daysToAdd,
            totalRemaining: totalRemaining,
            newEnd: newEnd,
          };
        });

        if (result.alreadyProcessed) {
          return {
            success: true,
            message: result.message,
            alreadyProcessed: true,
          };
        }

        const successMessage = result.wasExtension
          ? `🎉 تم تمديد اشتراكك بنجاح!\n` +
            `تمت إضافة ${result.daysAdded} يوم فوق اشتراكك الحالي.\n` +
            `المتبقي الآن: ${result.totalRemaining} يوم`
          : `🎉 تم تفعيل اشتراكك بنجاح لمدة ${result.daysAdded} يوم!`;

        return {
          success: true,
          message: successMessage,
          wasExtension: result.wasExtension,
          daysAdded: result.daysAdded,
          totalRemaining: result.totalRemaining,
          newEndDate: result.newEnd.toISOString(),
        };
      }

      return { success: false, message: `حالة الدفع: ${status}` };
    } catch (e) {
      console.error("verifyAlqasehPayment ERROR:", e);
      if (e instanceof functions.https.HttpsError) {
        throw e;
      }
      throw new functions.https.HttpsError(
        "internal",
        "خطأ في التحقق من الدفع: " + (e.message || "")
      );
    }
  }
);

// ============================================================
// 3) Webhook
// ============================================================
exports.alqasehWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const payload = req.body || {};
    console.log("Alqaseh Webhook Received:", JSON.stringify(payload));

    const paymentId = payload.payment_id;
    const orderId = payload.order_id;
    const status = (
      payload.payment_status ||
      payload.status ||
      ""
    ).toLowerCase();
    const customData = payload.custom_data || {};

    let userId = customData.user_id || null;
    let days = parseInt(customData.subscription_days || "0", 10) || 0;
    let orderRef = null;
    let orderData = null;

    if (orderId) {
      orderRef = db.collection(COLLECTION_ORDERS).doc(orderId);
      const doc = await orderRef.get();
      if (doc.exists) {
        orderData = doc.data();
        userId = userId || orderData.userId;
        days = days || orderData.days || SUBSCRIPTION_DAYS;
      }
    }

    if (!orderData && orderId) {
      const snap = await db
        .collection(COLLECTION_ORDERS)
        .where("orderId", "==", orderId)
        .limit(1)
        .get();
      if (!snap.empty) {
        orderRef = snap.docs[0].ref;
        orderData = snap.docs[0].data();
        userId = userId || orderData.userId;
        days = days || orderData.days || SUBSCRIPTION_DAYS;
      }
    }

    if (!userId) {
      console.warn("Webhook: userId غير معروف، تجاهل");
      res.status(200).send("No user");
      return;
    }

    const failureStates = [
      "failed",
      "declined",
      "canceled",
      "cancelled",
      "expired",
    ];
    if (failureStates.includes(status)) {
      if (orderRef) {
        await orderRef.update({
          status: "failed",
          failureReason: status,
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      res.status(200).send("Failed status recorded");
      return;
    }

    const successStates = ["succeeded", "success", "paid"];
    if (successStates.includes(status)) {
      await db.runTransaction(async (transaction) => {
        if (orderRef) {
          const freshOrder = await transaction.get(orderRef);
          const od = freshOrder.data() || {};
          if (od.status === "completed") {
            return;
          }
        }

        const userRef = db.collection("users").doc(userId);
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) {
          throw new Error("User not found");
        }

        const userData = userSnap.data() || {};
        const sub = userData.subscription || {};

        const {
          isCurrentlyActive,
          currentEnd,
          newStart,
          newEnd,
        } = computeNewSubscriptionDates(sub, days);

        transaction.update(userRef, {
          "subscription.status": "active",
          "subscription.startDate": admin.firestore.Timestamp.fromDate(
            newStart
          ),
          "subscription.endDate": admin.firestore.Timestamp.fromDate(newEnd),
          "subscription.plan": `${days}_days_paid`,
          "subscription.paymentMethod": "alqaseh_card",
          "subscription.paymentAmount":
            (orderData && orderData.amount) || SUBSCRIPTION_PRICE_IQD,
          "subscription.paymentId": paymentId || null,
          "subscription.lastOrderId": orderId || null,
          "subscription.activatedAt":
            admin.firestore.FieldValue.serverTimestamp(),
          "subscription.wasExtension": isCurrentlyActive,
        });

        if (orderRef) {
          transaction.update(orderRef, {
            status: "completed",
            paymentId: paymentId,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            previousEndDate: currentEnd
              ? admin.firestore.Timestamp.fromDate(currentEnd)
              : null,
            newEndDate: admin.firestore.Timestamp.fromDate(newEnd),
            daysAdded: days,
            wasExtension: isCurrentlyActive,
          });
        }

        // تحديث سجل الدفع
        if (orderId) {
          const txRef = db.collection(COLLECTION_TX).doc(orderId);
          transaction.set(
            txRef,
            {
              status: "succeeded",
              paymentId: paymentId,
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
              previousEndDate: currentEnd
                ? admin.firestore.Timestamp.fromDate(currentEnd)
                : null,
              newEndDate: admin.firestore.Timestamp.fromDate(newEnd),
              daysAdded: days,
              wasExtension: isCurrentlyActive,
            },
            { merge: true }
          );
        }

        // سجل التفعيل
        const logRef = db.collection(COLLECTION_LOGS).doc();
        transaction.set(logRef, {
          logId: logRef.id,
          userId: userId,
          userName: userData.displayName || "",
          userEmail: userData.email || "",
          type: "payment_activation",
          source: "alqaseh_card_webhook",
          orderId: orderId,
          paymentId: paymentId,
          daysAdded: days,
          wasExtension: isCurrentlyActive,
          previousEndDate: currentEnd
            ? admin.firestore.Timestamp.fromDate(currentEnd)
            : null,
          newEndDate: admin.firestore.Timestamp.fromDate(newEnd),
          amount:
            (orderData && orderData.amount) || SUBSCRIPTION_PRICE_IQD,
          currency: "IQD",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      console.log(
        `✅ Subscription activated for ${userId} | days=${days}`
      );
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error("Webhook ERROR:", e);
    res.status(500).send("Error");
  }
});

// ============================================================
// 4) استرداد المبلغ (المشرف العام فقط)
// ============================================================
exports.refundAlqasehPayment = functions.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "يجب تسجيل الدخول أولاً."
      );
    }

    const uid = context.auth.uid;

    // ✅ التحقق من الدور
    const meDoc = await db.collection("users").doc(uid).get();
    const meData = meDoc.data() || {};
const OWNER_EMAIL = "baronjnb@gmail.com";
if ((meData.email || "").toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
  throw new functions.https.HttpsError(
    "permission-denied",
    "هذه العملية متاحة لمالك التطبيق فقط."
  );
}

    const orderId = data && data.orderId ? String(data.orderId) : null;
    const reason =
      data && data.reason ? String(data.reason) : "طلب من الإدارة";

    if (!orderId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "معرف العملية مطلوب."
      );
    }

    try {
      const txRef = db.collection(COLLECTION_TX).doc(orderId);
      const txDoc = await txRef.get();
      if (!txDoc.exists) {
        throw new functions.https.HttpsError(
          "not-found",
          "سجل الدفع غير موجود."
        );
      }

      const txData = txDoc.data();

      if (txData.status === "refunded") {
        return { success: false, message: "تم استرداد هذا المبلغ مسبقاً." };
      }

      if (txData.status !== "succeeded") {
        return {
          success: false,
          message: `لا يمكن استرداد عملية بحالة: ${txData.status}`,
        };
      }

      const userId = txData.userId;
      const paymentId = txData.paymentId;

      // استدعاء API الاسترداد
      let refundResp;
      try {
        refundResp = await axios.post(
          `${ALQASEH_BASE_URL}/egw/payments/refund`,
          {
            payment_id: paymentId,
            reason: reason,
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: buildAuthHeader(),
            },
            timeout: 30000,
          }
        );
      } catch (apiError) {
        const msg =
          (apiError.response &&
            apiError.response.data &&
            apiError.response.data.message) ||
          apiError.message;
        console.error("Refund API Error:", msg);
        throw new functions.https.HttpsError(
          "internal",
          "فشل الاتصال ببوابة الاسترداد: " + msg
        );
      }

      const refundData = refundResp.data || {};
      const refundStatus = (refundData.status || "").toLowerCase();
      const refundId = refundData.refund_id || refundData.id || null;

      if (
        refundStatus &&
        refundStatus !== "succeeded" &&
        refundStatus !== "success" &&
        refundStatus !== "refunded"
      ) {
        throw new functions.https.HttpsError(
          "internal",
          `رفضت البوابة الاسترداد: ${refundStatus}`
        );
      }

      await db.runTransaction(async (transaction) => {
        const freshTx = await transaction.get(txRef);
        const freshData = freshTx.data() || {};
        if (freshData.status === "refunded") return;

        // 1) تحديث السجل
        transaction.update(txRef, {
          status: "refunded",
          refundId: refundId,
          refundReason: reason,
          refundedBy: uid,
          refundedByName: meData.displayName || "المشرف العام",
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // 2) تعديل اشتراك المستخدم
        const userRef = db.collection("users").doc(userId);
        const userSnap = await transaction.get(userRef);
        if (userSnap.exists) {
          const userData = userSnap.data() || {};
          const sub = userData.subscription || {};

          let restoreEnd = freshData.previousEndDate;
          if (!restoreEnd) {
            const current = toDate(sub.endDate);
            if (current) {
              const newEnd = new Date(
                current.getTime() -
                  (freshData.daysAdded || 0) * 24 * 60 * 60 * 1000
              );
              restoreEnd = admin.firestore.Timestamp.fromDate(newEnd);
            } else {
              restoreEnd = admin.firestore.Timestamp.fromDate(new Date());
            }
          }

          const now = new Date();
          const restoreEndDate = toDate(restoreEnd);
          const isStillActive =
            restoreEndDate && restoreEndDate.getTime() > now.getTime();

          transaction.update(userRef, {
            "subscription.endDate": restoreEnd,
            "subscription.status": isStillActive ? "active" : "expired",
            "subscription.lastRefundAt":
              admin.firestore.FieldValue.serverTimestamp(),
            "subscription.lastRefundBy":
              meData.displayName || "المشرف العام",
          });
        }

        // 3) سجل الاسترداد
        const logRef = db.collection(COLLECTION_LOGS).doc();
        transaction.set(logRef, {
          logId: logRef.id,
          userId: userId,
          userName: txData.userName || "",
          userEmail: txData.userEmail || "",
          type: "refund",
          orderId: orderId,
          paymentId: paymentId,
          refundId: refundId,
          amount: txData.amount,
          currency: txData.currency || "IQD",
          daysRemoved: txData.daysAdded || 0,
          reason: reason,
          refundedBy: uid,
          refundedByName: meData.displayName || "",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      return {
        success: true,
        message: "✅ تم استرداد المبلغ وإيقاف الاشتراك بنجاح.",
        refundId: refundId,
      };
    } catch (e) {
      console.error("refundAlqasehPayment ERROR:", e);
      if (e instanceof functions.https.HttpsError) throw e;
      throw new functions.https.HttpsError(
        "internal",
        "خطأ في الاسترداد: " + (e.message || "")
      );
    }
  }
);

// ============================================================
// 5) إحصائيات الدفع (المشرف العام فقط)
// ============================================================
exports.getPaymentStats = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "يجب تسجيل الدخول."
    );
  }

  const meDoc = await db.collection("users").doc(context.auth.uid).get();
  const meData = meDoc.data() || {};
const OWNER_EMAIL = "baronjnb@gmail.com";
if ((meData.email || "").toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
  throw new functions.https.HttpsError(
    "permission-denied",
    "هذه العملية متاحة لمالك التطبيق فقط."
  );
}

  const txSnap = await db.collection(COLLECTION_TX).get();
  let totalSucceeded = 0;
  let totalPending = 0;
  let totalFailed = 0;
  let totalRefunded = 0;
  let amountSucceeded = 0;
  let amountRefunded = 0;
  const uniquePayers = new Set();

  txSnap.forEach((doc) => {
    const d = doc.data();
    const st = d.status;
    if (st === "succeeded") {
      totalSucceeded++;
      amountSucceeded += d.amount || 0;
      uniquePayers.add(d.userId);
    } else if (st === "pending") {
      totalPending++;
    } else if (st === "failed") {
      totalFailed++;
    } else if (st === "refunded") {
      totalRefunded++;
      amountRefunded += d.amount || 0;
      uniquePayers.add(d.userId);
    }
  });

  return {
    totalTransactions: txSnap.size,
    totalSucceeded: totalSucceeded,
    totalPending: totalPending,
    totalFailed: totalFailed,
    totalRefunded: totalRefunded,
    uniquePayers: uniquePayers.size,
    amountSucceeded: amountSucceeded,
    amountRefunded: amountRefunded,
    netRevenue: amountSucceeded - amountRefunded,
  };
});

// ============================================================
// 6) Ping
// ============================================================
exports.ping = functions.https.onRequest((req, res) => {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    version: "2.0.0",
    authClientId: ALQASEH_CLIENT_ID,
    apiUrl: ALQASEH_BASE_URL,
    redirectUrl: REDIRECT_URL,
  });
});
/* eslint-enable */