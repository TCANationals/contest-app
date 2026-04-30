import type { FastifyInstance } from 'fastify';

export function registerContestantWs(app: FastifyInstance): void {
  app.get('/contestant', { websocket: true }, (socket /*, req */) => {
    // TODO(§8.2): validate room + id regex + token, attach to room.
    // TODO(§5.2): handle inbound HELP_REQUEST / HELP_CANCEL / PING.
    // TODO(§5.2): send initial STATE frame.
    socket.send(
      JSON.stringify({
        type: 'ERROR',
        code: 'NOT_IMPLEMENTED',
        message: 'contestant WS handler is a scaffold',
      }),
    );
    socket.close(1011, 'not implemented');
  });
}
