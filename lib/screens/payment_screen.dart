import 'package:flutter/material.dart';
import 'package:gym_course_manager/main.dart' hide PaymentService;
import 'package:webview_flutter/webview_flutter.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:google_fonts/google_fonts.dart';

import '../services/payment_service.dart';

class PaymentScreen extends StatefulWidget {
  final UserProfile profile;
  const PaymentScreen({super.key, required this.profile});

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> {
  WebViewController? _controller;
  bool _loading = true;
  String? _error;
  bool _paymentStarted = false;

  @override
  void initState() {
    super.initState();
    _startPayment();
  }

  Future<void> _startPayment() async {
    final url = await PaymentService.instance.createPayment(
      userId: widget.profile.uid,
      userEmail: widget.profile.email,
    );

    if (!mounted) return;

    if (url == null) {
      setState(() {
        _error = 'تعذر إنشاء طلب الدفع. يرجى المحاولة لاحقاً.';
        _loading = false;
      });
      return;
    }

    // تهيئة WebView لفتح صفحة الدفع
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (String url) {
            setState(() => _loading = true);
          },
          onPageFinished: (String url) {
            setState(() => _loading = false);
            // التحقق من صفحة النتيجة أو إعادة التوجيه
            if (url.contains('payment/result') || url.contains('success')) {
              _verifyPaymentOnServer();
            }
          },
          onWebResourceError: (WebResourceError error) {
            debugPrint('WebView Error: ${error.description}');
          },
        ),
      )
      ..loadRequest(Uri.parse(url));

    setState(() {
      _loading = false;
      _paymentStarted = true;
    });
  }

  /// استدعاء دالة سحابية للتحقق من حالة الدفع (الطريقة الآمنة)
  Future<void> _verifyPaymentOnServer() async {
    try {
      // استدعاء دالة Firebase Cloud Function
      final result = await FirebaseFunctions.instance
          .httpsCallable('verifyAlqasehPayment')
          .call({'userId': widget.profile.uid});

      final data = result.data as Map<dynamic, dynamic>;
      if (data['success'] == true) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('تم تفعيل اشتراكك بنجاح لمدة 90 يوماً!'),
              backgroundColor: Colors.green,
            ),
          );
          Navigator.pop(context, true); // إرجاع true لتحديث الشاشة
        }
      } else {
        throw Exception(data['message'] ?? 'لم يتم تأكيد الدفع بعد');
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = 'لم نتمكن من التحقق من الدفع: $e');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('الدفع بالبطاقة'),
        actions: [
          if (_paymentStarted)
            IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: () {
                setState(() {
                  _error = null;
                  _loading = true;
                  _paymentStarted = false;
                });
                _startPayment();
              },
            ),
        ],
      ),
      body: _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(Icons.error_outline,
                        size: 60, color: Colors.red),
                    const SizedBox(height: 16),
                    Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: GoogleFonts.cairo(fontSize: 16),
                    ),
                    const SizedBox(height: 24),
                    ElevatedButton(
                      onPressed: () {
                        setState(() {
                          _error = null;
                          _loading = true;
                          _paymentStarted = false;
                        });
                        _startPayment();
                      },
                      child: const Text('إعادة المحاولة'),
                    ),
                  ],
                ),
              ),
            )
          : _controller == null
              ? const Center(child: CircularProgressIndicator())
              : Stack(
                  children: [
                    WebViewWidget(controller: _controller!),
                    if (_loading)
                      const Center(child: CircularProgressIndicator()),
                  ],
                ),
    );
  }
}
