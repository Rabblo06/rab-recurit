import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsUUID,
} from 'class-validator';
export class FilePreviewsDto {
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ArrayUnique()
  fileIds!: string[];
}
