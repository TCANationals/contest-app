import type { FastifyInstance } from 'fastify';

export function registerJudgeWs(app: FastifyInstance): void {
  app.get('/judge', { websocket: true }, (socket /*, req */) => {
    // TODO(§8.1): verify ticket, look up identity, attach to room.
    // TODO(§5.2): handle inbound TIMER_* / HELP_ACK frames.
    // TODO(§5.2): send initial STATE + HELP_QUEUE frames.
    socket.send(
      JSON.stringify({
        type: 'ERROR',
        code: 'NOT_IMPLEMENTED',
        message: 'judge WS handler is a scaffold',
      }),
    );
    socket.close(1011, 'not implemented');
  });
}
