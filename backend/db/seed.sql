INSERT INTO employees (name, is_active) VALUES
  ('Vasca', 1),
  ('Flor', 1),
  ('Cami', 1);

INSERT INTO services (name, description, duration_minutes, price_ars, is_active) VALUES
  ('Lash Lifting', 'Levantamiento de pestañas con acabado natural.', 60, 22000, 1),
  ('Perfilado de Cejas', 'Diseño y perfilado personalizado.', 40, 16000, 1),
  ('Laminado de Cejas', 'Definición y orden de cejas con efecto peinado.', 50, 20000, 1),
  ('Lifting + Perfilado', 'Combo de pestañas y cejas.', 90, 34000, 1);

-- 1=Lunes, 2=Martes, ..., 5=Viernes. En SQLite con strftime('%w'): 1=lunes ... 5=viernes.
INSERT INTO employee_availability (employee_id, weekday, start_time, end_time) VALUES
  (1, 1, '09:00', '18:00'),
  (1, 2, '09:00', '18:00'),
  (1, 3, '09:00', '18:00'),
  (1, 4, '09:00', '18:00'),
  (1, 5, '09:00', '18:00'),
  (2, 1, '10:00', '17:00'),
  (2, 3, '10:00', '17:00'),
  (2, 5, '10:00', '17:00'),
  (3, 2, '11:00', '18:00'),
  (3, 4, '11:00', '18:00');
