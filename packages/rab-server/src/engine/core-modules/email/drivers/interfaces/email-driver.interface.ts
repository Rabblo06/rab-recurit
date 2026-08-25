import { EmailSendOptions } from '../../interfaces/email-send-options.interface';

export interface EmailDriverInterface {
  send(options: EmailSendOptions): Promise<void>;
}
