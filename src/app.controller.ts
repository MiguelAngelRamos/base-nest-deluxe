import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
//* [SECURE-FIX V4] Health check público — no expone datos sensibles
//* y debe ser alcanzable sin token para load balancers / probes.
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
