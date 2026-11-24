-- Public releases ship as ClueraAISetup-<version>.exe (no "Test" in the name).
-- Keep accepting the older ClueraAITestSetup-<version>.exe name so existing records stay valid.
do $$declare d text;
 a1 text:='ClueraAITestSetup-[0-9.]+[.]exe$';
 b1 text:='ClueraAI(Test)?Setup-[0-9.]+[.]exe$';
 a2 text:='right(p_input->>''downloadUrl'',length(''/ClueraAITestSetup-''||v||''.exe''))<>''/ClueraAITestSetup-''||v||''.exe''';
 b2 text:='(right(p_input->>''downloadUrl'',length(''/ClueraAISetup-''||v||''.exe''))<>''/ClueraAISetup-''||v||''.exe'' and right(p_input->>''downloadUrl'',length(''/ClueraAITestSetup-''||v||''.exe''))<>''/ClueraAITestSetup-''||v||''.exe'')';
begin
 d:=pg_get_functiondef('public.cluera_release_admin(uuid,uuid,text,uuid,text,jsonb)'::regprocedure);
 if (length(d)-length(replace(d,a1,'')))/length(a1)<>1 or (length(d)-length(replace(d,a2,'')))/length(a2)<>1
 then raise exception 'cluera_release_admin text changed; review before patching';end if;
 d:=replace(replace(d,a1,b1),a2,b2);
 execute d;
end$$;
