import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:flutter/material.dart';

class PaymentService {
  PaymentService._();
  static final PaymentService instance = PaymentService._();

  // بيانات بيئة الاختبار (UAT) من شركة القاصة
  static const String _baseUrl = 'https://api-test.alqaseh.com/v1';
  static const String _apiKey = '1X6Bvq65kpx1Yes5fYA5mbm8ixiexONo';
  static const String _merchantId = 'public_test';

  // سعر الاشتراك بالدينار العراقي
  static const int subscriptionPriceIQD = 5000;
  static const int subscriptionDays = 90;

  /// إنشاء طلب دفع جديد والحصول على رابط الدفع
  Future<String?> createPayment({
    required String userId,
    required String userEmail,
  }) async {
    try {
      // بيانات الطلب
      final payload = {
        'amount': subscriptionPriceIQD,
        'currency': 'IQD',
        'description': 'تفعيل اشتراك 90 يوم - مدير كورسات الجيم',
        'order_id': 'SUB_${userId}_${DateTime.now().millisecondsSinceEpoch}',
        'redirect_url':
            'https://yourapp.com/payment/result', // رابط العودة (يمكن أن يكون صفحة بسيطة)
        'transaction_type': 'Retail',
        'email': userEmail,
        'country': 'IQ',
        'custom_data': {
          'user_id': userId,
          'subscription_days': subscriptionDays,
        },
        'token_expiry_in_hour': 1,
      };

      final response = await http.post(
        Uri.parse('$_baseUrl/egw/payments/create'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization':
              'Basic ${base64Encode(utf8.encode('$_apiKey:$_apiKey'))}', // Basic Auth
        },
        body: jsonEncode(payload),
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        // استجابة الإنشاء تحتوي على payment_id و token
        // رابط الدفع المستضاف يكون عادةً بالشكل التالي:
        final paymentId = data['payment_id'];
        // ملاحظة: الرابط الدقيق قد يختلف حسب الوثائق، غالباً يكون بصيغة:
        // https://payment.alqaseh.com/pay/{token} أو ما شابه.
        // سأفترض أن الاستجابة تحتوي على حقل 'payment_url' أو يمكن بناؤه.
        // للأسف، الوثائق لم توضح الرابط بشكل صريح، لكنها ذكرت "token".
        // سأفترض أن الـ token هو ما يمثل رابط الدفع.
        final token = data['token'];
        if (token != null && token.toString().isNotEmpty) {
          // بناء رابط الدفع (قد تحتاج لتعديل هذا حسب الوثائق الرسمية)
          return 'https://payment.alqaseh.com/pay/$token';
        }
        // إذا كانت الاستجابة تحتوي على payment_url مباشرة
        if (data['payment_url'] != null) {
          return data['payment_url'];
        }
      } else {
        debugPrint(
            'Alqaseh Create Payment Error: ${response.statusCode} - ${response.body}');
      }
    } catch (e) {
      debugPrint('Alqaseh Create Payment Exception: $e');
    }
    return null;
  }

  /// (اختياري) التحقق من حالة الدفع مباشرة من التطبيق
  Future<bool> checkPaymentStatus(String paymentId) async {
    try {
      final response = await http.get(
        Uri.parse('$_baseUrl/egw/payments/history?payment_id=$paymentId'),
        headers: {
          'Authorization':
              'Basic ${base64Encode(utf8.encode('$_apiKey:$_apiKey'))}',
        },
      );
      if (response.statusCode == 200) {
        final list = jsonDecode(response.body) as List;
        if (list.isNotEmpty) {
          final status = list.first['payment_status'];
          return status == 'succeeded';
        }
      }
    } catch (e) {
      debugPrint('Check Payment Status Error: $e');
    }
    return false;
  }
}
