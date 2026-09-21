import { SetMetadata } from '@nestjs/common';

export const MANAGER_APPLICATION = 'rab.managerApplication';
/** Console-only endpoints require a session explicitly issued for Manager Web. */
export const ManagerApplication = () => SetMetadata(MANAGER_APPLICATION, true);
