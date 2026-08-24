'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { SwiftLogo } from '@/components/swift-logo';
import { getToken } from '@/lib/auth';
import { uploadSelfie } from '@/lib/customer';
import styles from './selfie.module.css';

const MAX_CAPTURE_EDGE = 1280;

function safeNext(value: string | null): string {
  return value && /^\/(?!\/)/.test(value) && !value.includes('..') && !value.includes('\\') ? value : '/order';
}

function SelfieSetup() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startingCamera, setStartingCamera] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequest = useRef(0);

  const stopCamera = useCallback(() => {
    cameraRequest.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraReady(false);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      const returnToSelfie = `/selfie?next=${encodeURIComponent(next)}`;
      router.replace(`/login?next=${encodeURIComponent(returnToSelfie)}`);
    }
  }, [next, router]);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  useEffect(() => () => {
    cameraRequest.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const startCamera = async () => {
    setStartingCamera(true);
    setError(null);
    stopCamera();
    const request = ++cameraRequest.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot open a camera. Use a phone or computer with camera access to continue.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'user' } },
      });
      if (cameraRequest.current !== request) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        throw new Error('The camera preview could not start.');
      }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraReady(true);
    } catch (cameraError) {
      if (cameraRequest.current !== request) return;
      stopCamera();
      setError(cameraError instanceof Error ? cameraError.message : 'Swift could not open the camera.');
      setStartingCamera(false);
    } finally {
      if (cameraRequest.current === request) setStartingCamera(false);
    }
  };

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setError('The camera is not ready yet. Try again in a moment.');
      return;
    }
    const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      setError('This browser could not capture the camera frame.');
      return;
    }
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) {
      setError('This browser could not prepare the captured photo.');
      return;
    }
    setFile(new File([blob], 'swift-camera-selfie.jpg', { type: 'image/jpeg' }));
    stopCamera();
  };

  const save = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadSelfie(file);
      router.replace(next);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Could not save this profile photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="selfie-title">
        <Link href={next} aria-label="Return to store" className={styles.brandHome}><SwiftLogo /></Link>
        <div>
          <p className={styles.eyebrow}>One step before your first order</p>
          <h1 id="selfie-title" className={styles.title}>Add your profile photo</h1>
        </div>
        <p className={styles.copy}>
          The business and rider use this photo to recognize who is ordering. Take it now with this device’s front camera; Swift requires a captured profile photo before an account can place an order.
        </p>

        <div className={styles.preview}>
          {preview ? (
            <Image src={preview} alt="Captured profile photo preview" fill unoptimized className={styles.previewImage} />
          ) : (
            <video
              ref={videoRef}
              className={styles.video}
              autoPlay
              muted
              playsInline
              aria-label="Front camera preview"
            />
          )}
          {!preview && !cameraReady ? (
            <p className={styles.cameraPlaceholder}>Your live front-camera preview appears here.</p>
          ) : null}
        </div>

        <div className={styles.cameraActions}>
          {preview ? (
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => { setError(null); setFile(null); }}>
              Retake photo
            </button>
          ) : cameraReady ? (
            <button type="button" className={styles.primary} onClick={() => void capturePhoto()}>
              Take photo now
            </button>
          ) : (
            <button type="button" className={styles.primary} disabled={startingCamera} onClick={() => void startCamera()}>
              {startingCamera ? 'Opening camera…' : 'Turn on front camera'}
            </button>
          )}
        </div>

        <p className={styles.privacy}>The captured frame is sent as a JPEG and becomes your Swift profile picture. This page does not accept gallery uploads.</p>
        {error ? <p className={styles.alert} role="alert">{error}</p> : null}
        <button type="button" className={styles.primary} disabled={!file || busy} onClick={() => void save()}>
          {busy ? 'Saving photo…' : 'Save captured photo and continue'}
        </button>
        <Link href={next} className={styles.back}>Back to the store</Link>
      </section>
    </main>
  );
}

export default function SelfiePage() {
  return (
    <Suspense fallback={<main className={styles.page}><p>Loading account setup…</p></main>}>
      <SelfieSetup />
    </Suspense>
  );
}
