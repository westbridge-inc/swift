import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_typography.dart';

class OtpScreen extends StatefulWidget {
  final String phone;
  const OtpScreen({super.key, required this.phone});

  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> {
  final _otpController = TextEditingController();
  bool _isLoading = false;

  @override
  void dispose() {
    _otpController.dispose();
    super.dispose();
  }

  Future<void> _verifyOtp() async {
    if (_otpController.text.length != 6) return;

    setState(() => _isLoading = true);

    // TODO: Call auth API to verify OTP + store tokens.
    await Future.delayed(const Duration(seconds: 1));

    if (!mounted) return;
    setState(() => _isLoading = false);
    // On success, enter the 4-tab consumer shell.
    context.go('/home');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 24),

              const Text('Enter verification code', style: AppTypography.h2),
              const SizedBox(height: 8),
              Text(
                'We sent a 6-digit code to ${widget.phone}',
                style: AppTypography.body.copyWith(color: AppColors.textSecondary),
              ),

              const SizedBox(height: 32),

              // OTP input
              TextFormField(
                controller: _otpController,
                keyboardType: TextInputType.number,
                autofocus: true,
                maxLength: 6,
                style: AppTypography.h2.copyWith(letterSpacing: 8),
                textAlign: TextAlign.center,
                decoration: const InputDecoration(counterText: ''),
                onChanged: (value) {
                  if (value.length == 6) _verifyOtp();
                },
              ),

              const SizedBox(height: 24),

              // Verify button
              ElevatedButton(
                onPressed: _isLoading ? null : _verifyOtp,
                child: _isLoading
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Text('Verify'),
              ),

              const SizedBox(height: 16),

              // Resend
              Center(
                child: TextButton(
                  onPressed: () {
                    // TODO: Resend OTP
                  },
                  child: Text(
                    'Resend code',
                    style: AppTypography.bodyMedium.copyWith(color: AppColors.info),
                  ),
                ),
              ),

              const SizedBox(height: 8),

              // Dev hint
              Center(
                child: Text(
                  'Dev mode: use 123456',
                  style: AppTypography.small,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
