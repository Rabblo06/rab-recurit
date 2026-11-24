import { Module, OnModuleInit } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { FileAccessRegistry } from '../../engine/core-modules/storage/file-access.registry';
import { FileKind } from '../../engine/core-modules/storage/file-kinds';
import {
  MyStaffDocumentsController,
  StaffDocumentRequirementsController,
  StaffDocumentsController,
} from './controllers/staff-documents.controller';
import { StaffDocumentFilePolicy } from './files/staff-document-file.policy';
import { StaffDocumentService } from './services/staff-document.service';

/**
 * Lane D: staff documents with an expiry. Its own module (not StaffModule) so it stays self-contained: the controllers, the
 * service, and the STAFF_DOCUMENT read policy registered with the storage engine at boot (engine/ never imports modules/).
 */
@Module({
  imports: [AuthModule],
  controllers: [
    StaffDocumentsController,
    MyStaffDocumentsController,
    StaffDocumentRequirementsController,
  ],
  providers: [StaffDocumentService],
  exports: [StaffDocumentService],
})
export class StaffDocumentModule implements OnModuleInit {
  constructor(
    private readonly registry: FileAccessRegistry,
    private readonly documents: StaffDocumentService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      [FileKind.STAFF_DOCUMENT],
      new StaffDocumentFilePolicy(this.documents),
    );
  }
}
