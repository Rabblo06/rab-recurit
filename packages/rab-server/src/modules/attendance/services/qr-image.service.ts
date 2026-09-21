import { Injectable } from '@nestjs/common';
import QRCode from 'qrcode';

/** Renders a signed QR token to a printable PNG — high error-correction, since the physical output is a printed sheet that may get creased/dirty. */
@Injectable()
export class QrImageService {
  async generatePng(token: string, widthPx = 600): Promise<Buffer> {
    return QRCode.toBuffer(token, { type: 'png', width: widthPx, errorCorrectionLevel: 'H', margin: 2 });
  }
}
