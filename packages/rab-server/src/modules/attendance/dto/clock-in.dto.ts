import { IsUUID } from 'class-validator';

export class ClockInDto {
  @IsUUID()
  shiftId!: string;
}
