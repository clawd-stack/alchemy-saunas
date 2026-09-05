import { mountAdminPage } from '/admin/shell.js';
import { renderAudit } from '/admin/audit.js';

mountAdminPage({
  roles: ['admin', 'manager'],
  run: async () => renderAudit(document.getElementById('audit')),
});
