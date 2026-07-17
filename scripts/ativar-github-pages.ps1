# Ativa o GitHub Pages deste repositório servindo a raiz da branch main.
#
# Só precisa ser rodado UMA vez, quando o Pages ainda não está ativado.
# Depois disso, publicar uma atualização é apenas `git push` — o Pages
# reconstrói o site sozinho.
#
# O token do GitHub é lido na hora da credencial já guardada no Gerenciador
# de Credenciais do Windows (via `git credential fill`), então nada precisa
# ser digitado nem fica exposto no script.
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\ativar-github-pages.ps1

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# dono/repositório: descobre a partir do remote 'origin'
$urlOrigin = git remote get-url origin
if ($urlOrigin -match 'github\.com[:/](?<dono>[^/]+)/(?<repo>[^/.]+)') {
  $dono = $Matches['dono']
  $repo = $Matches['repo']
} else {
  throw "Não consegui identificar dono/repo pelo remote origin: $urlOrigin"
}
Write-Output "Repositório: $dono/$repo"

# Lê a credencial salva do GitHub sem exibi-la
$tmpEntrada = Join-Path $env:TEMP 'cred-query.txt'
[IO.File]::WriteAllText($tmpEntrada, "protocol=https`nhost=github.com`n`n", [Text.Encoding]::ASCII)
$fill = cmd /c "git credential fill < `"$tmpEntrada`""
Remove-Item $tmpEntrada -Force
$cred = @{}
foreach ($linha in $fill) {
  if ($linha -match '^(\w+)=(.*)$') { $cred[$Matches[1]] = $Matches[2] }
}
if (-not $cred['password']) { throw 'Nenhuma credencial encontrada para github.com' }

$headers = @{
  Authorization = "token $($cred['password'])"
  Accept        = 'application/vnd.github+json'
  'User-Agent'  = 'deploy-script'
}

# Ativa o Pages: raiz ('/') da branch main
$urlPages = "https://api.github.com/repos/$dono/$repo/pages"
$body = @{ source = @{ branch = 'main'; path = '/' } } | ConvertTo-Json

try {
  $pages = Invoke-RestMethod -Uri $urlPages -Method Post -Headers $headers -Body $body -ContentType 'application/json'
  Write-Output "Pages ativado: $($pages.html_url)"
} catch {
  Write-Output "POST falhou (talvez já esteja ativado): $($_.ErrorDetails.Message)"
  $pages = Invoke-RestMethod -Uri $urlPages -Headers $headers
  Write-Output "Estado atual: $($pages.html_url) (status: $($pages.status))"
}
