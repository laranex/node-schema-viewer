import { Controller, Get, Module } from '@nestjs/common';

@Controller()
class AppController {
    @Get()
    index(): string {
        return 'The application\n';
    }
}

@Module({ controllers: [AppController] })
export class AppModule {}
